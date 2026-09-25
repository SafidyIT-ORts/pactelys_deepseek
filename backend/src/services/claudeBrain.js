/**
 * services/claudeBrain.js — Le "cerveau" IA de Pactelys.
 *
 * Double provider : DeepSeek (deepseek-flash / deepseek-v4-pro) ET l'API
 * Claude réelle (Anthropic), au choix via le paramètre `provider`
 * ('deepseek' | 'claude') accepté par toutes les fonctions publiques.
 * DEFAUT = 'deepseek' PARTOUT : si un appelant ne précise rien, le
 * comportement est strictement identique à avant — aucune régression.
 *
 * Résolution de modèle par palier (DeepSeek uniquement) : les agents
 * gtm-agents-main précisent un modèle Claude dans leur frontmatter
 * (haiku/sonnet/opus). On mappe :
 *   haiku, sonnet -> deepseek-flash   (rapide, suffisant pour la plupart des tâches)
 *   opus          -> deepseek-v4-pro  (raisonnement, étapes stratégiques)
 * deepseek-v4-pro renvoie un `reasoning_content` séparé du texte final
 * (`content`) — il faut donc lire `message.content`, pas concaténer les
 * deux, et prévoir un max_tokens plus généreux (le raisonnement consomme
 * du budget avant la réponse finale).
 *
 * Avec provider='claude' : même mapping de palier que DeepSeek, mais vers
 * de vrais id Anthropic (haiku -> claude-haiku-4-5-20251001, etc. — voir
 * resolveClaudeModel) puisque le frontmatter ne donne qu'un nom court.
 */

import fs from 'fs/promises'
import path from 'path'
import { fetchUrlSafely, crawlSite, checkDomainEmail } from '../utils/safeFetch.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MODEL_FAST = process.env.DEEPSEEK_MODEL_FAST || 'deepseek-flash'
const MODEL_REASONING = process.env.DEEPSEEK_MODEL_REASONING || 'deepseek-v4-pro'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const CLAUDE_DEFAULT_MODEL = process.env.CLAUDE_DEFAULT_MODEL || 'claude-haiku-4-5-20251001'

/**
 * Outils réellement exécutables mis à disposition des agents — c'est ce
 * qui manquait pour "faire comme Claude Code" : sans ça, le modèle ne
 * peut que générer du texte à partir de ce qu'on lui donne, il ne peut
 * jamais aller vérifier un fait par lui-même (site du client, concurrent
 * cité, etc.) et le dit explicitement dans ses réponses plutôt que
 * d'inventer. `fetch_url` lui donne cette capacité, en conservant les
 * garde-fous SSRF (voir utils/safeFetch.js).
 */
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Récupère le contenu réel d\'une URL — page HTML (titre, texte visible, métadonnées SEO : meta description, canonical, H1/H2, couverture alt, nombre de mots ; SÉCURITÉ : HTTPS, expiration réelle du certificat TLS, en-têtes HSTS/CSP/X-Frame-Options, contenu mixte http:// sur une page https ; SCHEMA.ORG : chaque bloc JSON-LD détecté avec son type et sa validité — JSON malformé ou champs requis manquants signalés explicitement, pas juste recommandé d\'en ajouter ; STACK TECHNIQUE : CMS/e-commerce (WordPress, Shopify, PrestaShop...), outils d\'analytics/tracking (GA4, GTM, Meta Pixel...), chat (Intercom, Crisp...) détectés dans le HTML/en-têtes ; langue déclarée + hreflang (sites multi-pays) ; profils sociaux réels détectés (LinkedIn, X, Instagram, Facebook, YouTube)) OU sitemap XML (liste des URLs + dates de dernière modif) OU flux RSS/Atom (derniers articles d\'un blog avec titre/date/lien — utile pour observer la cadence de publication d\'un concurrent). Fonctionne sur n\'importe quel site : WordPress/Yoast, PrestaShop, Shopify... les formats XML sont des standards, pas propres à un CMS. Suit les redirections et renvoie CHAQUE saut avec son code exact (301 permanente / 302 temporaire). N\'invente jamais un contenu, un code de redirection, une donnée SEO/sécurité/Schema.org que tu n\'as pas vérifiée avec cet outil.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL complète (http:// ou https://) de la page à consulter.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Recherche sur le web (façon Google) et renvoie une liste de résultats (titre, URL, extrait). À utiliser pour TROUVER une source (actualité, page probable d\'un prospect, contexte général) — ensuite, vérifie le contenu exact avec `fetch_url` sur l\'URL la plus pertinente avant d\'affirmer un fait. Pour trouver de VRAIES entreprises françaises à prospecter, préfère `search_companies_france` (registre officiel) à cet outil. Ne jamais inventer un nom d\'entreprise, un dirigeant ou une adresse email sans être passé par ces outils.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Requête de recherche, en langage naturel ou mots-clés.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_companies_france',
      description: 'Recherche de VRAIES entreprises françaises dans le registre officiel (recherche-entreprises.api.gouv.fr, données INSEE/RNE). Renvoie nom, SIREN, adresse, dirigeant, effectif, secteur d\'activité — filtré sur les entreprises actives uniquement. C\'est la source à utiliser EN PRIORITÉ (avant `web_search`) dès qu\'il s\'agit de trouver de vraies entreprises françaises à prospecter par secteur/métier/ville : c\'est un registre officiel, pas une recherche web générique.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Mot-clé libre : secteur d\'activité, métier ou nom d\'entreprise (ex: "rénovation énergétique", "traiteur événementiel").' },
          code_postal: { type: 'string', description: 'Code postal pour restreindre la recherche à une ville (optionnel).' },
          departement: { type: 'string', description: 'Numéro de département, 2 chiffres, ex: "75", "44" (optionnel).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'keyword_ideas',
      description: 'Donne de VRAIES requêtes associées à un sujet, via l\'autocomplétion Google (gratuit, sans clé) — utile pour trouver des angles de contenu ou des intentions de recherche réelles avant de rédiger un article/une page SEO. ATTENTION : ce n\'est PAS un volume de recherche (il n\'existe pas d\'équivalent gratuit à Ahrefs/SEMrush) — ce sont des suggestions de requêtes réelles, pas des statistiques chiffrées. Ne jamais présenter ces suggestions comme un "volume de recherche mensuel" ou un chiffre : dis explicitement que ce sont des pistes d\'intention, pas des données de volume.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Sujet ou début de requête à explorer (ex: "rénovation énergétique").' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crawl_site',
      description: 'Parcourt un site en interne (comme Screaming Frog, en plus limité) en suivant les liens depuis une page de départ — jusqu\'à `max_pages` pages. Détecte : profondeur de clic depuis la page de départ, maillage interne (combien de liens internes reçoit chaque page, laquelle n\'en reçoit aucune), chaînes de redirection (A→B→C au lieu d\'un lien direct A→C), boucles de redirection, erreurs HTTP (4xx/5xx), temps de réponse par page, CONTENU DUPLIQUÉ (paires de pages dont le texte se recoupe à ≥75%, détecté par shingles — un vrai signal de cannibalisation/duplication, pas une supposition) et THIN CONTENT (pages à moins de 200 mots de texte visible). Fournis `sitemap_url` pour détecter les VRAIES pages orphelines (listées dans le sitemap mais jamais atteintes par un lien interne — un crawl seul ne peut structurellement jamais trouver ça). Opération lente (plusieurs dizaines de requêtes) : à utiliser pour un audit structurel, pas pour vérifier une seule page (préfère `fetch_url` pour ça).',
      parameters: {
        type: 'object',
        properties: {
          start_url: { type: 'string', description: 'URL de départ du crawl (généralement la page d\'accueil).' },
          max_pages: { type: 'integer', description: 'Nombre max de pages à explorer (défaut 30, plafond 60 — au-delà, découpe le site par section et relance plusieurs crawls).' },
          sitemap_url: { type: 'string', description: 'Optionnel : URL d\'un sitemap de PAGES (pas un index) pour détecter les vraies pages orphelines par comparaison.' },
        },
        required: ['start_url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'legal_announcements_france',
      description: 'Recherche de VRAIES annonces légales françaises en temps réel (BODACC — Bulletin officiel des annonces civiles et commerciales, source officielle gratuite) : créations d\'entreprise, cessions/ventes de fonds de commerce, PROCÉDURES COLLECTIVES (redressement/liquidation judiciaire — signal de risque avant de prospecter ou de signer un partenariat). Utile pour trouver de vrais signaux d\'achat (création récente = entreprise qui a besoin de tout), vérifier la santé légale d\'un prospect/partenaire, ou surveiller les mouvements d\'un concurrent. Ne jamais présenter une absence de résultat comme une preuve de bonne santé légale — dis explicitement que rien n\'a été trouvé sur la période/le périmètre interrogé.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nom d\'entreprise, secteur ou mot-clé à rechercher (ex: "Boulangerie Martin", "rénovation énergétique").' },
          departement: { type: 'string', description: 'Numéro de département, 2 chiffres, ex: "75", "69" (optionnel).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_domain_email',
      description: 'Vérifie qu\'un domaine a de VRAIS enregistrements MX valides (peut réellement recevoir des emails) — simple lookup DNS, aucune API tierce. Utilise-le avant de recommander une adresse email sur ce domaine ou de qualifier un prospect : un domaine sans MX est mort, mal configuré, ou n\'a jamais été destiné à recevoir des emails professionnels. Ne remplace pas une vérification d\'adresse email précise (ça, c\'est Hunter/Apollo, payant) — ça confirme seulement que le DOMAINE est vivant.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Nom de domaine à vérifier (ex: "pactelys.fr"). Accepte aussi une URL complète, le domaine en sera extrait.' },
        },
        required: ['domain'],
      },
    },
  },
]

/**
 * Convertit AGENT_TOOLS (format OpenAI/DeepSeek : `{type:'function', function:{name, description, parameters}}`)
 * vers le format Anthropic (`{name, description, input_schema}`, à plat).
 * Un seul point de vérité pour la liste d'outils — jamais deux listes à
 * maintenir en parallèle.
 *
 * @param {Array<object>} tools
 * @returns {Array<{ name: string, description: string, input_schema: object }>}
 */
function toAnthropicTools(tools) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}
const AGENT_TOOLS_ANTHROPIC = toAnthropicTools(AGENT_TOOLS)

const TOOL_USAGE_HINT = '\n\nOUTILS DISPONIBLES : `search_companies_france` (registre officiel des entreprises françaises — à utiliser EN PRIORITÉ pour trouver de vraies entreprises par secteur/ville), `legal_announcements_france` (BODACC officiel — créations, cessions, procédures collectives : signaux d\'achat ou de risque réels), `web_search` (recherche web générale, pour actualités/signaux), `fetch_url` (lire le contenu réel d\'une page précise, avec ses métadonnées SEO/sécurité/Schema.org/stack technique/réseaux sociaux, ou un flux RSS/Atom), `keyword_ideas` (vraies requêtes associées à un sujet, pas un volume de recherche), `check_domain_email` (un domaine peut-il réellement recevoir des emails — à vérifier avant de recommander une adresse) et `crawl_site` (parcourir un site en interne pour un audit structurel : maillage, pages orphelines, chaînes de redirection, erreurs, contenu dupliqué/thin — à utiliser pour un audit de site complet, pas pour une seule page). Utilise ces outils systématiquement avant d\'affirmer un fait vérifiable (nom d\'entreprise, dirigeant, actualité, contenu d\'un site, donnée SEO/technique/légale) plutôt que de formuler une hypothèse — et dis explicitement quand tu n\'as pas pu vérifier (recherche infructueuse, page inaccessible), ainsi que quand une donnée est un signal d\'intention et non une statistique exacte (cas de `keyword_ideas`).'

/**
 * Adaptateur DeepSeek/OpenAI : `arguments` arrive en JSON string à parser,
 * puis délègue à `_runTool` (logique métier commune aux deux providers).
 *
 * @param {{ id: string, function: { name: string, arguments: string } }} toolCall
 * @returns {Promise<string>}
 */
async function _executeToolCall(toolCall) {
  const { name, arguments: argsRaw } = toolCall.function
  let args
  try {
    args = JSON.parse(argsRaw || '{}')
  } catch {
    console.log(JSON.stringify({ event: 'tool_call', tool: name, ok: false, error: 'bad arguments JSON' }))
    return 'Erreur : arguments d\'outil invalides.'
  }
  return _runTool(name, args)
}

/**
 * Exécute un outil (args déjà parsés) et retourne le texte à renvoyer au
 * modèle (jamais d'exception non gérée : une erreur d'outil doit rester
 * exploitable par le modèle, pas casser la requête). Logique métier
 * commune aux deux providers — Anthropic envoie `input` déjà en objet,
 * DeepSeek en JSON string (voir `_executeToolCall` ci-dessus pour ce cas).
 *
 * @param {string} name
 * @param {object} args
 * @returns {Promise<string>}
 */
async function _runTool(name, args) {
  if (name === 'fetch_url') {
    try {
      const { title, text, finalUrl, seo, sitemap, feed, security, schemaOrg, techStack, tls, redirectChain } = await fetchUrlSafely(args.url)
      console.log(JSON.stringify({ event: 'tool_call', tool: name, url: args.url, ok: true, finalUrl, title, hops: redirectChain.length }))

      const redirectBlock = redirectChain.length
        ? `Redirections suivies (${redirectChain.length}) :\n` + redirectChain.map((h, i) =>
            `  ${i + 1}. ${h.from} → ${h.to} (HTTP ${h.status}, ${[301, 308].includes(h.status) ? 'permanente' : 'temporaire'})`
          ).join('\n') + '\n\n'
        : ''

      if (sitemap) {
        const kind = sitemap.isIndex ? 'index de sitemaps' : 'sitemap de pages'
        const list = sitemap.entries.map(e => `  - ${e.url}${e.lastmod ? ` (dernière modif. : ${e.lastmod})` : ''}`).join('\n')
        const truncNote = sitemap.total > sitemap.entries.length ? `\n  … (${sitemap.total - sitemap.entries.length} de plus, non listées)` : ''
        return `${redirectBlock}URL consultée : ${finalUrl}\nType : ${kind} XML — ${sitemap.total} entrée(s) au total\n\n${list}${truncNote}`
      }

      if (feed) {
        const list = feed.items.map(it => `  - ${it.title}${it.date ? ` (${it.date})` : ''}${it.link ? `\n    ${it.link}` : ''}`).join('\n')
        const truncNote = feed.total > feed.items.length ? `\n  … (${feed.total - feed.items.length} de plus, non listés)` : ''
        return `${redirectBlock}URL consultée : ${finalUrl}\nType : flux ${feed.format.toUpperCase()} — "${feed.title || '(sans titre)'}" — ${feed.total} entrée(s) au total\n\n${list}${truncNote}`
      }

      if (!seo) {
        return `${redirectBlock}URL consultée : ${finalUrl}\nType : contenu XML (pas un sitemap reconnu)\n\nContenu :\n${text}`
      }

      const seoBlock = [
        `Meta description : ${seo.metaDescription || '(absente)'}`,
        `Canonical : ${seo.canonical || '(absent)'}`,
        `H1 : ${seo.h1.length ? seo.h1.join(' | ') : '(aucun)'}`,
        `H2 (${seo.h2.length}) : ${seo.h2.length ? seo.h2.slice(0, 6).join(' | ') : '(aucun)'}`,
        `Images : ${seo.imagesTotal} au total, ${seo.imagesWithAlt} avec attribut alt renseigné`,
        `Nombre de mots (texte visible) : ${seo.wordCount}`,
        `Langue déclarée (html lang) : ${seo.lang || '(absente)'}`,
        `Hreflang : ${seo.hreflang.length ? seo.hreflang.map(h => `${h.lang}→${h.url}`).join(' | ') : '(aucun)'}`,
        `Profils sociaux détectés : ${seo.socialLinks.length ? seo.socialLinks.map(s => `${s.platform} (${s.url})`).join(' | ') : '(aucun)'}`,
      ].join('\n')

      const securityLines = [
        `HTTPS : ${security.isHttps ? 'oui' : 'NON — page servie en clair'}`,
        `Certificat TLS : ${tls ? `émis par ${tls.issuer}, expire dans ${tls.daysRemaining} jour(s) (${tls.validTo})${tls.daysRemaining < 30 ? ' ⚠️ EXPIRE BIENTÔT' : ''}${!tls.authorized ? ' ⚠️ CHAÎNE NON VALIDÉE' : ''}` : '(non vérifiable)'}`,
        `HSTS (Strict-Transport-Security) : ${security.hsts || '(absent)'}`,
        `CSP (Content-Security-Policy) : ${security.csp || '(absent)'}`,
        `X-Frame-Options : ${security.xFrameOptions || '(absent)'}`,
        `X-Content-Type-Options : ${security.xContentTypeOptions || '(absent)'}`,
        `Contenu mixte (ressources http:// sur une page https) : ${security.mixedContentCount} trouvée(s)${security.mixedContentSample.length ? '\n  ' + security.mixedContentSample.join('\n  ') : ''}`,
      ].join('\n')

      const schemaBlock = schemaOrg.count === 0
        ? 'Aucun bloc Schema.org (JSON-LD) détecté sur cette page.'
        : schemaOrg.schemas.map((s, i) =>
            s.error
              ? `  ${i + 1}. JSON-LD MALFORMÉ (erreur de parsing : ${s.error})`
              : `  ${i + 1}. Type "${s.type}" — ${s.valid ? 'valide' : 'INCOMPLET : ' + s.issues.join(', ')}`
          ).join('\n')

      const techBlock = [
        techStack.detected.length
          ? techStack.detected.map(t => `  - ${t.name} (${t.category})`).join('\n')
          : '  Aucune signature reconnue (stack non identifiable depuis le HTML public).',
        techStack.serverHeader ? `  En-tête Server : ${techStack.serverHeader}` : null,
        techStack.poweredBy ? `  En-tête X-Powered-By : ${techStack.poweredBy}` : null,
      ].filter(Boolean).join('\n')

      return `${redirectBlock}URL consultée : ${finalUrl}\nTitre : ${title || '(aucun)'}\n\nDonnées SEO :\n${seoBlock}\n\nSécurité :\n${securityLines}\n\nSchema.org (${schemaOrg.count} bloc(s) JSON-LD) :\n${schemaBlock}\n\nStack technique détectée :\n${techBlock}\n\nContenu :\n${text}`
    } catch (err) {
      console.log(JSON.stringify({ event: 'tool_call', tool: name, url: args.url, ok: false, error: err.message }))
      return `Échec de la consultation de l'URL : ${err.message}`
    }
  }

  if (name === 'web_search') {
    try {
      const { source, results } = await _webSearch(args.query)
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: true, source }))
      return `Résultats de recherche (source : ${source}) pour "${args.query}" :\n\n${results}`
    } catch (err) {
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: false, error: err.message }))
      return `Échec de la recherche web : ${err.message}`
    }
  }

  if (name === 'search_companies_france') {
    try {
      const results = await _searchCompaniesFrance(args.query, { code_postal: args.code_postal, departement: args.departement })
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: true }))
      return `Entreprises françaises réelles (source : registre officiel recherche-entreprises.api.gouv.fr) pour "${args.query}" :\n\n${results}`
    } catch (err) {
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: false, error: err.message }))
      return `Échec de la recherche d'entreprises : ${err.message}`
    }
  }

  if (name === 'keyword_ideas') {
    try {
      const results = await _getKeywordIdeas(args.query)
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: true }))
      return `Requêtes associées (source : autocomplétion Google — signal d'intention, PAS un volume de recherche) pour "${args.query}" :\n\n${results}`
    } catch (err) {
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: false, error: err.message }))
      return `Échec de la récupération des suggestions : ${err.message}`
    }
  }

  if (name === 'crawl_site') {
    try {
      const result = await crawlSite(args.start_url, args.max_pages, args.sitemap_url)
      console.log(JSON.stringify({ event: 'tool_call', tool: name, start_url: args.start_url, ok: true, pages_crawled: result.pagesCrawled }))
      return _formatCrawlResult(result)
    } catch (err) {
      console.log(JSON.stringify({ event: 'tool_call', tool: name, start_url: args.start_url, ok: false, error: err.message }))
      return `Échec du crawl : ${err.message}`
    }
  }

  if (name === 'legal_announcements_france') {
    try {
      const results = await _getLegalAnnouncementsFrance(args.query, { departement: args.departement })
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: true }))
      return `Annonces légales réelles (source : BODACC, officiel) pour "${args.query}" :\n\n${results}`
    } catch (err) {
      console.log(JSON.stringify({ event: 'tool_call', tool: name, query: args.query, ok: false, error: err.message }))
      return `Échec de la recherche BODACC : ${err.message}`
    }
  }

  if (name === 'check_domain_email') {
    try {
      const result = await checkDomainEmail(args.domain)
      console.log(JSON.stringify({ event: 'tool_call', tool: name, domain: args.domain, ok: true, hasMx: result.hasMx }))
      if (!result.hasMx) {
        return `Domaine "${result.domain}" : AUCUN enregistrement MX valide${result.error ? ` (${result.error})` : ''} — ce domaine ne peut pas recevoir d'emails actuellement.`
      }
      const mxList = result.mxRecords.map(r => `  - ${r.exchange} (priorité ${r.priority})`).join('\n')
      return `Domaine "${result.domain}" : MX valides trouvés, domaine capable de recevoir des emails.\n${mxList}`
    } catch (err) {
      console.log(JSON.stringify({ event: 'tool_call', tool: name, domain: args.domain, ok: false, error: err.message }))
      return `Échec de la vérification du domaine : ${err.message}`
    }
  }

  console.log(JSON.stringify({ event: 'tool_call', tool: name, ok: false, error: 'unknown tool' }))
  return `Erreur : outil "${name}" inconnu.`
}

/**
 * Condense le résultat brut de `crawlSite` (jusqu'à 60 pages détaillées)
 * en un résumé exploitable — un dump page par page saturerait le contexte
 * du modèle sans rien apporter de plus que la liste des vrais problèmes.
 *
 * @param {Awaited<ReturnType<typeof crawlSite>>} result
 * @returns {string}
 */
function _formatCrawlResult(result) {
  const { startUrl, maxPages, pagesDiscovered, pagesCrawled, pagesNotCrawled, orphanPages, duplicatePairs, thinContentPages, pages } = result

  const broken = pages.filter(p => p.crawled && (p.error || (p.status && p.status >= 400)))
  const chains = pages.filter(p => p.redirectHops > 1)
  const loops = pages.filter(p => p.error === 'Boucle de redirection détectée')
  const weakLinking = pages.filter(p => p.crawled && p.url !== startUrl && p.incomingLinksCount <= 1)
    .sort((a, b) => a.incomingLinksCount - b.incomingLinksCount).slice(0, 10)
  const hubs = [...pages].filter(p => p.crawled).sort((a, b) => b.incomingLinksCount - a.incomingLinksCount).slice(0, 5)
  const slowest = pages.filter(p => p.crawled && p.responseTimeMs != null).sort((a, b) => b.responseTimeMs - a.responseTimeMs).slice(0, 5)
  const maxDepth = Math.max(0, ...pages.filter(p => p.crawled).map(p => p.depth))

  const lines = []
  lines.push(`Crawl depuis : ${startUrl}`)
  lines.push(`Pages découvertes : ${pagesDiscovered} | Explorées : ${pagesCrawled} | Non explorées (limite ${maxPages} atteinte) : ${pagesNotCrawled}`)
  lines.push(`Profondeur maximale atteinte : ${maxDepth} clic(s) depuis la page de départ`)

  lines.push(`\n--- Pages en erreur (${broken.length}) ---`)
  lines.push(broken.length
    ? broken.map(p => `  - ${p.url} : ${p.error || `HTTP ${p.status}`} (profondeur ${p.depth})`).join('\n')
    : '  Aucune.')

  lines.push(`\n--- Chaînes de redirection >1 saut (${chains.length}) ---`)
  lines.push(chains.length
    ? chains.map(p => `  - ${p.url} : ${p.redirectHops} sauts → ` + p.redirectChain.map(h => `${h.status}`).join('→')).join('\n')
    : '  Aucune (les redirections trouvées, s\'il y en a, sont directes A→B).')

  if (loops.length) {
    lines.push(`\n--- ⚠️ Boucles de redirection détectées (${loops.length}) ---`)
    lines.push(loops.map(p => `  - ${p.url}`).join('\n'))
  }

  lines.push(`\n--- Maillage interne faible (0-1 lien entrant, hors page de départ) — ${weakLinking.length} exemple(s) sur un total à vérifier ---`)
  lines.push(weakLinking.length
    ? weakLinking.map(p => `  - ${p.url} : ${p.incomingLinksCount} lien(s) entrant(s) (profondeur ${p.depth})`).join('\n')
    : '  Aucune page mal maillée détectée dans le périmètre exploré.')

  lines.push(`\n--- Pages "hub" (le plus de liens internes entrants) ---`)
  lines.push(hubs.map(p => `  - ${p.url} : ${p.incomingLinksCount} lien(s) entrant(s)`).join('\n'))

  lines.push(`\n--- Pages les plus lentes ---`)
  lines.push(slowest.map(p => `  - ${p.url} : ${p.responseTimeMs} ms`).join('\n'))

  if (orphanPages) {
    if (Array.isArray(orphanPages)) {
      lines.push(`\n--- Pages orphelines réelles (présentes dans le sitemap, jamais atteintes par un lien interne) : ${orphanPages.length} ---`)
      lines.push(orphanPages.length ? orphanPages.map(u => `  - ${u}`).join('\n') : '  Aucune.')
    } else {
      lines.push(`\n--- Détection des pages orphelines : ${orphanPages.error} ---`)
    }
  } else {
    lines.push(`\n--- Pages orphelines ---\n  Non vérifiable sans \`sitemap_url\` : par construction, un crawl seul ne peut jamais découvrir une page à 0 lien entrant (il ne la trouve qu'en suivant un lien vers elle).`)
  }

  lines.push(`\n--- Contenu dupliqué (paires de pages ≥75% de texte en commun, détecté par shingles) : ${duplicatePairs.length} ---`)
  lines.push(duplicatePairs.length
    ? duplicatePairs.map(d => `  - ${d.similarityPercent}% similaire : ${d.urlA}  ⟷  ${d.urlB}`).join('\n')
    : '  Aucune paire détectée dans le périmètre exploré.')

  lines.push(`\n--- Thin content (pages à moins de 200 mots de texte visible) : ${thinContentPages.length} ---`)
  lines.push(thinContentPages.length
    ? thinContentPages.map(p => `  - ${p.url} : ${p.wordCount} mot(s)`).join('\n')
    : '  Aucune page en dessous du seuil dans le périmètre exploré.')

  return lines.join('\n')
}

/**
 * Suggestions de requêtes réelles via l'autocomplétion Google — gratuit,
 * sans clé, sans inscription (endpoint public utilisé par de nombreux
 * outils SEO gratuits). Ce n'est PAS un volume de recherche : Google ne
 * fournit ça gratuitement nulle part (Ahrefs/SEMrush restent payants pour
 * ça). C'est un vrai signal d'intention de recherche, pas une statistique.
 *
 * @param {string} query
 * @returns {Promise<string>}
 */
async function _getKeywordIdeas(query) {
  if (!query || !query.trim()) {
    throw new Error('Requête de recherche vide.')
  }

  // ie/oe=UTF-8 : sans ça, Google renvoie parfois du Latin-1 pour les
  // accents malgré client=firefox — bug réel trouvé en test (« opportunit�s »).
  // Décodage manuel en UTF-8 (au lieu de res.json()) pour ne dépendre
  // d'aucune détection d'encodage implicite côté fetch.
  const params = new URLSearchParams({ client: 'firefox', hl: 'fr', ie: 'UTF-8', oe: 'UTF-8', q: query })
  const res = await fetch(`https://suggestqueries.google.com/complete/search?${params}`, {
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) {
    throw new Error(`Google Autocomplete a renvoyé HTTP ${res.status}`)
  }
  const buf = await res.arrayBuffer()
  const data = JSON.parse(new TextDecoder('utf-8').decode(buf))
  const suggestions = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : []
  if (suggestions.length === 0) {
    return `Aucune suggestion trouvée pour "${query}".`
  }
  return suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

/**
 * Recherche de vraies entreprises françaises via le registre officiel
 * (data.gouv.fr / DINUM), sans clé, sans inscription — c'est l'API que le
 * modèle lui-même a suggérée pendant un test (préférable à Sirene brut
 * pour un usage prospection : plus simple, pas de souscription requise).
 * Filtre automatiquement sur les entreprises actives (etat_administratif=A).
 *
 * @param {string} query
 * @param {{ code_postal?: string, departement?: string }} [filters]
 * @returns {Promise<string>}
 */
async function _searchCompaniesFrance(query, filters = {}) {
  if (!query || !query.trim()) {
    throw new Error('Requête de recherche vide.')
  }

  const params = new URLSearchParams({ q: query, etat_administratif: 'A', per_page: '8' })
  if (filters.code_postal) params.set('code_postal', filters.code_postal)
  if (filters.departement) params.set('departement', filters.departement)

  const res = await fetch(`https://recherche-entreprises.api.gouv.fr/search?${params}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    throw new Error(`API Recherche d'Entreprises (gouv.fr) a renvoyé HTTP ${res.status}`)
  }
  const data = await res.json()

  const results = (data.results || []).slice(0, 8).map(r => {
    const dirigeant = (r.dirigeants || [])[0]
    return [
      `- ${r.nom_complet || r.nom_raison_sociale} (SIREN ${r.siren})`,
      `  Activité : ${r.activite_principale || '?'} | Effectif : ${r.tranche_effectif_salarie || '?'} | Catégorie : ${r.categorie_entreprise || '?'}`,
      `  Adresse : ${r.siege?.adresse || '?'}`,
      dirigeant ? `  Dirigeant : ${[dirigeant.prenoms, dirigeant.nom].filter(Boolean).join(' ')} (${dirigeant.qualite || 'fonction non précisée'})` : null,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  return results || `Aucune entreprise active trouvée pour "${query}".`
}

/**
 * Annonces légales françaises réelles via le BODACC (Bulletin officiel des
 * annonces civiles et commerciales), source officielle DILA — gratuite,
 * sans clé, sans inscription. Couvre créations, cessions/ventes de fonds
 * de commerce, et procédures collectives (redressement/liquidation
 * judiciaire) — un vrai signal d'achat (création récente) ou de risque
 * (procédure collective en cours) que ni web_search ni search_companies_france
 * ne peuvent donner (le registre officiel des entreprises ne montre pas
 * ces événements, seulement l'état actuel).
 *
 * @param {string} query
 * @param {{ departement?: string }} [filters]
 * @returns {Promise<string>}
 */
async function _getLegalAnnouncementsFrance(query, filters = {}) {
  if (!query || !query.trim()) {
    throw new Error('Requête de recherche vide.')
  }

  const escapedQuery = query.replace(/"/g, '\\"')
  let where = `search("${escapedQuery}")`
  if (filters.departement) where += ` AND numerodepartement="${filters.departement}"`

  const params = new URLSearchParams({ where, limit: '10', order_by: 'dateparution desc' })
  const res = await fetch(`https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records?${params}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    throw new Error(`API BODACC a renvoyé HTTP ${res.status}`)
  }
  const data = await res.json()

  const results = (data.results || []).slice(0, 10).map(r => {
    return [
      `- ${r.commercant || '(nom non précisé)'} — ${r.familleavis_lib || r.typeavis_lib || 'type non précisé'}`,
      `  Ville : ${r.ville || '?'} (dép. ${r.numerodepartement || '?'}) | Publié le : ${r.dateparution || '?'}`,
      r.registre?.length ? `  SIREN/RCS : ${r.registre[0]}` : null,
      `  Tribunal : ${(r.tribunal || '?').replace(/\n/g, ' ')}`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  return results || `Aucune annonce légale trouvée pour "${query}"${filters.departement ? ` dans le département ${filters.departement}` : ''}.`
}

/**
 * Recherche web gratuite pour les agents (équivalent DeepSeek du `WebSearch`
 * natif de Claude Code, qui n'existe pas côté API DeepSeek).
 *
 * Deux sources, dans l'ordre :
 *  1. SearXNG auto-hébergé (service `pactelys-searxng` du docker-compose) —
 *     gratuit à vie, sans clé, sans quota. Source privilégiée.
 *  2. Jina AI Deep Search (s.jina.ai) — aucune clé requise pour un usage de
 *     base, sert de repli si SearXNG est absent/indisponible (ex: variable
 *     SEARXNG_URL non définie, conteneur pas encore démarré).
 *
 * @param {string} query
 * @returns {Promise<{ source: 'searxng' | 'jina', results: string }>}
 */
async function _webSearch(query) {
  if (!query || !query.trim()) {
    throw new Error('Requête de recherche vide.')
  }

  const searxngUrl = process.env.SEARXNG_URL
  if (searxngUrl) {
    try {
      const res = await fetch(`${searxngUrl}/search?format=json&q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const data = await res.json()
        const results = (data.results || [])
          .slice(0, 8)
          .map(r => `- ${r.title}\n  ${r.url}\n  ${(r.content || '').slice(0, 300)}`)
          .join('\n\n')
        if (results) return { source: 'searxng', results }
      }
    } catch {
      // Repli silencieux sur Jina ci-dessous — SearXNG peut être down
      // sans que ça bloque l'agent.
    }
  }

  const jinaRes = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
    headers: {
      'Accept': 'text/plain',
      ...(process.env.JINA_API_KEY ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!jinaRes.ok) {
    throw new Error(`SearXNG indisponible et Jina AI a renvoyé HTTP ${jinaRes.status}`)
  }
  const text = await jinaRes.text()
  return { source: 'jina', results: text.slice(0, 4000) }
}

/**
 * Résout un nom de modèle Claude (ex: "claude-haiku-4-5-20251001") vers
 * le modèle DeepSeek équivalent. Défaut = rapide si rien ne matche.
 *
 * @param {string} claudeModelName
 * @returns {string}
 */
function resolveDeepSeekModel(claudeModelName) {
  if (/opus/i.test(claudeModelName || '')) return MODEL_REASONING
  return MODEL_FAST
}

/**
 * Résout un palier de modèle (le frontmatter gtm-agents-main donne un nom
 * court : "haiku" / "sonnet" / "opus", PAS un vrai id Anthropic) vers le
 * vrai id de modèle Claude à appeler. Si un id complet est déjà fourni
 * (ex: "claude-sonnet-5"), il est conservé tel quel plutôt que perdu.
 *
 * @param {string} [tierOrModelName]
 * @returns {string}
 */
function resolveClaudeModel(tierOrModelName) {
  const t = (tierOrModelName || '').toLowerCase()
  // Les mots-clés de palier sont vérifiés AVANT le passthrough "déjà un id
  // complet" : un ancien id retiré comme "claude-3-5-sonnet-20241022"
  // (envoyé par un appelant qui ne connaît pas les modèles actuels)
  // contient quand même "sonnet" et doit être remappé, pas renvoyé tel
  // quel — sinon 404 "model not found" côté Anthropic (bug réel trouvé
  // en test).
  if (t.includes('opus')) return 'claude-opus-5'
  if (t.includes('sonnet')) return 'claude-sonnet-5'
  if (t.includes('haiku')) return 'claude-haiku-4-5-20251001'
  if (t.startsWith('claude-')) return tierOrModelName
  return CLAUDE_DEFAULT_MODEL
}

/**
 * Lit les 3 fichiers markdown d'un client depuis le disque
 * (écrits par GET /v1/organizations/:id/markdown-files dans /app/clients/{orgId}/).
 *
 * @param {string} orgId
 * @returns {Promise<{ brand: string, s01: string, claude: string }>}
 */
async function readClientConfig(orgId) {
  const orgDir = path.join('/app/clients', orgId)

  const [brand, s01, claude] = await Promise.all([
    fs.readFile(path.join(orgDir, 'Brand.md'), 'utf-8'),
    fs.readFile(path.join(orgDir, 'S01.md'), 'utf-8'),
    fs.readFile(path.join(orgDir, 'CLAUDE.md'), 'utf-8'),
  ])

  return { brand, s01, claude }
}

/**
 * Appelle DeepSeek avec un system prompt (déjà injecté avec les .md)
 * et un message utilisateur, et retourne le texte généré.
 *
 * @param {string} systemPrompt - prompt système, .md déjà injectés
 * @param {string} userMessage - message utilisateur (tâche demandée)
 * @param {string} [model] - nom de modèle Claude d'origine, utilisé pour résoudre le palier
 * @param {'deepseek'|'claude'} [provider] - défaut 'deepseek', comportement inchangé si omis
 * @returns {Promise<string>}
 */
async function callClaudeAPI(systemPrompt, userMessage, model, provider = 'deepseek') {
  if (provider === 'claude') {
    const { text } = await _runAgentLoopClaude(systemPrompt, userMessage, resolveClaudeModel(model))
    return text
  }
  return _callDeepSeek(systemPrompt, userMessage, resolveDeepSeekModel(model))
}

/**
 * Utilisée par POST /v1/ai/generate : lit les fichiers du client puis
 * génère du contenu à partir d'un type d'action et d'une consigne libre.
 *
 * @param {{ orgId: string, actionType: string, userInput: string, model?: string, provider?: 'deepseek'|'claude' }} params
 * @returns {Promise<{ success: true, result: string, model_used: string, provider: string }>}
 */
async function generateContent({ orgId, actionType, userInput, model, provider = 'deepseek' }) {
  const files = await readClientConfig(orgId)

  const systemPrompt = [
    files.claude,
    files.brand,
    files.s01,
    `\n## Tâche demandée\nType d'action : ${actionType}`,
  ].join('\n\n---\n\n')

  if (provider === 'claude') {
    const claudeModel = resolveClaudeModel(model)
    const { text } = await _runAgentLoopClaude(systemPrompt, userInput, claudeModel)
    return { success: true, result: text, model_used: claudeModel, provider: 'claude' }
  }

  const deepSeekModel = resolveDeepSeekModel(model)
  const result = await _callDeepSeek(systemPrompt, userInput, deepSeekModel)

  return { success: true, result, model_used: deepSeekModel, provider: 'deepseek' }
}

const MAX_CONTINUATIONS = 3
// 5 était trop bas — bug réel trouvé en test : une commande demandant
// plusieurs éléments vérifiés (ex. generate-leads --count 2, chaque lead
// nécessitant recherche + vérification MX + lecture de site) épuisait la
// limite avant la fin et coupait la réponse en pleine réflexion
// ("...je cherche maintenant un 2e lead"). La discipline de vérification
// systématique (CLAUDE.md) coûte des rounds — mieux vaut une limite
// généreuse qu'une réponse tronquée.
const MAX_TOOL_ROUNDS = 20

/**
 * Un seul appel à l'API DeepSeek. Retourne le message complet (pas
 * seulement le texte) car un appel avec finish_reason 'tool_calls' a un
 * `content` vide et porte l'info utile dans `tool_calls`.
 *
 * @param {Array<object>} messages
 * @param {string} deepSeekModel
 * @returns {Promise<{ message: object, finishReason: string }>}
 */
async function _callDeepSeekOnce(messages, deepSeekModel, tools) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY est absent des variables d\'environnement. ' +
      'Ajoute ta clé DeepSeek dans .env.'
    )
  }

  const isReasoning = deepSeekModel === MODEL_REASONING

  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: deepSeekModel,
      messages,
      ...(tools ? { tools } : {}),
      // Volontairement haut : un brief/pipeline multi-étapes peut produire
      // un long document, et DeepSeek peut couper avant ce plafond si le
      // contexte cumulé (system + historique) est déjà volumineux — voir
      // la boucle de continuation ci-dessous.
      max_tokens: isReasoning ? 16000 : 8000,
    }),
  })

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`DeepSeek API error ${response.status}: ${errBody}`)
  }

  const data = await response.json()
  const choice = data?.choices?.[0]
  const message = choice?.message || {}
  const finishReason = choice?.finish_reason || 'stop'

  if (finishReason !== 'tool_calls' && !message.content) {
    throw new Error(`Réponse DeepSeek vide ou inattendue : ${JSON.stringify(data).slice(0, 500)}`)
  }

  return { message, finishReason }
}

/**
 * Appelle DeepSeek avec accès à `fetch_url` (boucle agentique — le modèle
 * peut demander un outil, on l'exécute réellement, on lui renvoie le
 * résultat, il continue, jusqu'à MAX_TOOL_ROUNDS) ET relance
 * automatiquement une continuation si la réponse finale a été coupée
 * avant sa fin naturelle (finish_reason === 'length') — sinon on renvoie
 * silencieusement un document tronqué en plein milieu d'une phrase, ce
 * qui s'est produit en test (pipeline à 3 étapes, brief long) : la
 * 3e étape a été coupée alors même que max_tokens autorisait plus, parce
 * que le contexte cumulé (system prompt + résultat des étapes
 * précédentes) laissait moins de place disponible que prévu.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} deepSeekModel - 'deepseek-flash' | 'deepseek-v4-pro'
 * @returns {Promise<string>}
 */
async function _runAgentLoop(systemPrompt, userMessage, deepSeekModel) {
  const messages = [
    { role: 'system', content: systemPrompt + TOOL_USAGE_HINT },
    { role: 'user', content: userMessage },
  ]

  let fullText = ''
  let toolRounds = 0
  const toolCallsTrace = []

  // ---- Boucle agentique : outils ----
  for (;;) {
    const { message, finishReason } = await _callDeepSeekOnce(messages, deepSeekModel, AGENT_TOOLS)

    if (finishReason === 'tool_calls' && toolRounds < MAX_TOOL_ROUNDS) {
      toolRounds += 1
      messages.push(message) // le message assistant portant les tool_calls doit être rejoué tel quel
      for (const call of (message.tool_calls || [])) {
        const result = await _executeToolCall(call)
        toolCallsTrace.push({
          tool: call.function.name,
          arguments: call.function.arguments,
          result_preview: result.slice(0, 300),
        })
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
      continue
    }

    // ---- Boucle anti-troncature ----
    let text = message.content || ''
    let currentFinishReason = finishReason
    let attempts = 0
    fullText = text

    while (currentFinishReason === 'length' && attempts < MAX_CONTINUATIONS) {
      attempts += 1
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'user', content: 'Continue exactement là où tu t\'es arrêté, sans répéter ce qui a déjà été écrit et sans réintroduction.' })
      const cont = await _callDeepSeekOnce(messages, deepSeekModel, AGENT_TOOLS)
      text = cont.message.content || ''
      currentFinishReason = cont.finishReason
      fullText += text
    }

    break
  }

  return { text: fullText, toolCalls: toolCallsTrace }
}

/**
 * Version texte-seul de _runAgentLoop, pour les appelants existants
 * (callClaudeAPI, generateContent) qui n'ont pas besoin de la trace des
 * outils utilisés.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} deepSeekModel
 * @returns {Promise<string>}
 */
async function _callDeepSeek(systemPrompt, userMessage, deepSeekModel) {
  const { text } = await _runAgentLoop(systemPrompt, userMessage, deepSeekModel)
  return text
}

/**
 * Un seul appel à l'API Claude (Anthropic Messages). Contrairement à
 * DeepSeek/OpenAI, le system prompt est un paramètre séparé (`system`),
 * pas un message dans `messages` — et la réponse est une liste de blocs
 * (`content`), pas un `message.content` unique : un tool_use et du texte
 * peuvent coexister dans la même réponse.
 *
 * @param {Array<object>} messages
 * @param {string} systemPrompt
 * @param {string} claudeModel
 * @param {Array<object>|null} tools
 * @returns {Promise<{ content: Array<object>, stopReason: string }>}
 */
async function _callClaudeOnce(messages, systemPrompt, claudeModel, tools) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY est absent des variables d\'environnement. ' +
      'Ajoute ta clé Claude dans .env.'
    )
  }

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: claudeModel,
      max_tokens: 8000,
      system: systemPrompt,
      messages,
      ...(tools ? { tools } : {}),
    }),
  })

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`Claude API error ${response.status}: ${errBody}`)
  }

  const data = await response.json()
  return { content: data.content || [], stopReason: data.stop_reason || 'end_turn' }
}

/**
 * Équivalent Claude de `_runAgentLoop` : même contrat (texte final + trace
 * des outils), même boucle agentique et même logique anti-troncature —
 * adaptées au format Anthropic (tool_use/tool_result au lieu de
 * tool_calls, stop_reason 'max_tokens' au lieu de finish_reason 'length').
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} claudeModel
 * @returns {Promise<{ text: string, toolCalls: Array<object> }>}
 */
async function _runAgentLoopClaude(systemPrompt, userMessage, claudeModel) {
  const fullSystemPrompt = systemPrompt + TOOL_USAGE_HINT
  const messages = [{ role: 'user', content: userMessage }]

  let toolRounds = 0
  const toolCallsTrace = []

  for (;;) {
    const { content, stopReason } = await _callClaudeOnce(messages, fullSystemPrompt, claudeModel, AGENT_TOOLS_ANTHROPIC)

    if (stopReason === 'tool_use' && toolRounds < MAX_TOOL_ROUNDS) {
      toolRounds += 1
      messages.push({ role: 'assistant', content })
      const toolResults = []
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        const result = await _runTool(block.name, block.input)
        toolCallsTrace.push({
          tool: block.name,
          arguments: JSON.stringify(block.input),
          result_preview: result.slice(0, 300),
        })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    let text = content.filter(b => b.type === 'text').map(b => b.text).join('')
    let currentStopReason = stopReason
    let attempts = 0
    let fullText = text

    while (currentStopReason === 'max_tokens' && attempts < MAX_CONTINUATIONS) {
      attempts += 1
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'user', content: 'Continue exactement là où tu t\'es arrêté, sans répéter ce qui a déjà été écrit et sans réintroduction.' })
      const cont = await _callClaudeOnce(messages, fullSystemPrompt, claudeModel, AGENT_TOOLS_ANTHROPIC)
      text = cont.content.filter(b => b.type === 'text').map(b => b.text).join('')
      currentStopReason = cont.stopReason
      fullText += text
    }

    return { text: fullText, toolCalls: toolCallsTrace }
  }
}

/**
 * Comme callClaudeAPI, mais renvoie aussi la trace des outils réellement
 * appelés (nom, arguments, aperçu du résultat) — pour que le client
 * puisse vérifier qu'une affirmation "vérifié" dans le texte généré
 * correspond bien à un appel d'outil réel, pas à une déclaration en l'air.
 * Utilisée par /v1/actions/execute-auto.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} [model] - nom de modèle Claude d'origine (résolution de palier)
 * @param {'deepseek'|'claude'} [provider] - défaut 'deepseek', comportement inchangé si omis
 * @returns {Promise<{ text: string, toolCalls: Array<object> }>}
 */
async function callAgentStep(systemPrompt, userMessage, model, provider = 'deepseek') {
  if (provider === 'claude') {
    return _runAgentLoopClaude(systemPrompt, userMessage, resolveClaudeModel(model))
  }
  return _runAgentLoop(systemPrompt, userMessage, resolveDeepSeekModel(model))
}

/**
 * Complétion SANS outils ni instructions d'usage d'outils — pour les
 * appels qui exigent une sortie strictement contrainte (ex: le routeur
 * JSON de pluginRouter.js). Avec les outils activés, le modèle peut
 * choisir de vérifier un fait via fetch_url puis répondre en prose au
 * lieu du JSON attendu, cassant le contrat — ce qui s'est produit en
 * test. Gère quand même la continuation anti-troncature.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} deepSeekModel
 * @returns {Promise<string>}
 */
async function _routingCompletionDeepSeek(systemPrompt, userMessage, deepSeekModel) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]

  let { message, finishReason } = await _callDeepSeekOnce(messages, deepSeekModel, null)
  let text = message.content || ''
  let fullText = text
  let attempts = 0

  while (finishReason === 'length' && attempts < MAX_CONTINUATIONS) {
    attempts += 1
    messages.push({ role: 'assistant', content: text })
    messages.push({ role: 'user', content: 'Continue exactement là où tu t\'es arrêté.' })
    const cont = await _callDeepSeekOnce(messages, deepSeekModel, null)
    text = cont.message.content || ''
    finishReason = cont.finishReason
    fullText += text
  }

  return fullText
}

/**
 * Équivalent Claude de `_routingCompletionDeepSeek` — même contrat (texte
 * contraint, pas d'outils), adapté au format Anthropic (system séparé,
 * stop_reason 'max_tokens').
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} claudeModel
 * @returns {Promise<string>}
 */
async function _routingCompletionClaude(systemPrompt, userMessage, claudeModel) {
  const messages = [{ role: 'user', content: userMessage }]

  let { content, stopReason } = await _callClaudeOnce(messages, systemPrompt, claudeModel, null)
  let text = content.filter(b => b.type === 'text').map(b => b.text).join('')
  let fullText = text
  let attempts = 0

  while (stopReason === 'max_tokens' && attempts < MAX_CONTINUATIONS) {
    attempts += 1
    messages.push({ role: 'assistant', content: text })
    messages.push({ role: 'user', content: 'Continue exactement là où tu t\'es arrêté.' })
    const cont = await _callClaudeOnce(messages, systemPrompt, claudeModel, null)
    text = cont.content.filter(b => b.type === 'text').map(b => b.text).join('')
    stopReason = cont.stopReason
    fullText += text
  }

  return fullText
}

/**
 * Dispatcher provider — `model` est déjà le vrai id de modèle pour le
 * provider choisi (c'est l'appelant, pluginRouter.js, qui décide lequel
 * passer). Défaut 'deepseek' : un appel existant sans 4e argument garde
 * exactement le même comportement qu'avant.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} model
 * @param {'deepseek'|'claude'} [provider]
 * @returns {Promise<string>}
 */
async function _routingCompletion(systemPrompt, userMessage, model, provider = 'deepseek') {
  if (provider === 'claude') {
    return _routingCompletionClaude(systemPrompt, userMessage, model)
  }
  return _routingCompletionDeepSeek(systemPrompt, userMessage, model)
}

export default {
  readClientConfig,
  callClaudeAPI,
  callAgentStep,
  generateContent,
  resolveDeepSeekModel,
  _callDeepSeek,
  _routingCompletion,
}
