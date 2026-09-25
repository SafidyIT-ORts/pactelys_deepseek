/**
 * utils/safeFetch.js — Récupère une page web réelle pour l'outil `fetch_url`
 * exposé aux agents (services/claudeBrain.js). Le modèle choisit l'URL
 * à partir de la demande du client / du contenu qu'il génère : c'est donc
 * une requête HTTP sortante déclenchée indirectement par une entrée
 * utilisateur. Protections SSRF nécessaires :
 *   - http/https uniquement
 *   - résolution DNS puis rejet des IP privées/loopback/link-local
 *     AVANT chaque requête, y compris à chaque redirection suivie
 *     manuellement (une redirection peut pointer vers une IP interne
 *     même si le nom d'hôte initial était public)
 *   - timeout + taille de réponse plafonnés
 */

import dns from 'dns/promises'
import net from 'net'
import tls from 'tls'

const TIMEOUT_MS = 10000
const MAX_BYTES = 2_000_000
const MAX_TEXT_CHARS = 6000
const MAX_REDIRECTS = 3

/**
 * Résout un hostname et rejette les IP privées/loopback/link-local —
 * factorisé pour être appelé identiquement par `fetchUrlSafely` ET le
 * crawler `crawlSite` : une vérification de sécurité ne doit jamais être
 * dupliquée (risque de divergence silencieuse entre les deux copies).
 *
 * @param {string} hostname
 * @returns {Promise<void>}
 */
async function _resolveAndCheckPublic(hostname) {
  let address
  try {
    ;({ address } = await dns.lookup(hostname))
  } catch {
    throw new Error(`Impossible de résoudre le nom d'hôte "${hostname}"`)
  }
  if (isPrivateIp(address)) {
    throw new Error(`Accès refusé : "${hostname}" pointe vers une adresse réseau privée/interne.`)
  }
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 (unique local)
  if (lower.startsWith('fe80')) return true // link-local
  return false
}

/**
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
function htmlToText(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : ''

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '… [tronqué]'
  return { title, text }
}

/**
 * Extrait les métadonnées SEO réelles d'une page (meta description,
 * canonical, H1/H2, couverture des attributs alt) — c'est ce qui manquait
 * pour qu'un agent SEO fasse un vrai audit au lieu de deviner : jusqu'ici
 * `fetch_url` jetait tout sauf le titre et le texte visible. Parsing par
 * regex (pas de dépendance DOM), cohérent avec le reste du fichier —
 * suffisant pour de la lecture, pas pour du HTML malformé exotique.
 *
 * @param {string} html
 * @returns {{ metaDescription: string, canonical: string, h1: string[], h2: string[], imagesTotal: number, imagesWithAlt: number, wordCount: number }}
 */
function extractSeoData(html, plainText) {
  const metas = {}
  const metaRegex = /<meta\s+[^>]*>/gi
  let m
  while ((m = metaRegex.exec(html))) {
    const tag = m[0]
    // Backreference (\1) au lieu de [^"'] : une valeur française contient
    // souvent une apostrophe ("L'Institut...") qui coupait l'extraction à
    // 1 caractère si on excluait bêtement les deux types de guillemets —
    // bug réel trouvé en test (meta description tronquée à "L").
    const nameMatch = tag.match(/(?:name|property)\s*=\s*(["'])(.*?)\1/i)
    const contentMatch = tag.match(/content\s*=\s*(["'])(.*?)\1/i)
    if (nameMatch && contentMatch) metas[nameMatch[2].toLowerCase()] = contentMatch[2].trim()
  }
  const metaDescription = metas['description'] || metas['og:description'] || ''

  const canonicalMatch =
    html.match(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*(["'])(.*?)\1/i) ||
    html.match(/<link\s+[^>]*href\s*=\s*(["'])(.*?)\1[^>]*rel\s*=\s*["']canonical["']/i)
  const canonical = canonicalMatch ? canonicalMatch[2] : ''

  const extractHeadings = (tag) => {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
    const out = []
    let hm
    while ((hm = regex.exec(html)) && out.length < 10) {
      const clean = hm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (clean) out.push(clean)
    }
    return out
  }

  let imagesTotal = 0
  let imagesWithAlt = 0
  const imgRegex = /<img\s+[^>]*>/gi
  let im
  while ((im = imgRegex.exec(html))) {
    imagesTotal++
    const altMatch = im[0].match(/alt\s*=\s*(["'])(.*?)\1/i)
    if (altMatch && altMatch[2].trim()) imagesWithAlt++
  }

  const wordCount = plainText ? plainText.split(/\s+/).filter(Boolean).length : 0

  const langMatch = html.match(/<html[^>]+lang\s*=\s*(["'])(.*?)\1/i)
  const lang = langMatch ? langMatch[2].trim() : null

  const hreflang = []
  const hreflangRegex = /<link\s+[^>]*rel\s*=\s*["']alternate["'][^>]*>/gi
  let hm2
  while ((hm2 = hreflangRegex.exec(html))) {
    const tag = hm2[0]
    const code = tag.match(/hreflang\s*=\s*(["'])(.*?)\1/i)
    const href = tag.match(/href\s*=\s*(["'])(.*?)\1/i)
    if (code && href) hreflang.push({ lang: code[2].trim(), url: href[2].trim() })
  }

  // Réseaux sociaux : liens vers un profil (pas un simple bouton de partage
  // générique) — motifs restreints aux formes /company/, /in/, /@handle,
  // /pages/ etc. pour éviter de remonter des liens "partager sur X" sans
  // rapport avec le profil réel de l'entreprise.
  const socialPatterns = [
    { platform: 'LinkedIn', regex: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9_-]+/gi },
    { platform: 'Facebook', regex: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share\.php)[A-Za-z0-9.]+/gi },
    { platform: 'Instagram', regex: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/gi },
    { platform: 'X/Twitter', regex: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share)[A-Za-z0-9_]+/gi },
    { platform: 'YouTube', regex: /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|@)[A-Za-z0-9_-]+/gi },
  ]
  const socialLinks = []
  for (const { platform, regex } of socialPatterns) {
    const found = html.match(regex)
    if (found?.length) socialLinks.push({ platform, url: found[0] })
  }

  return {
    metaDescription,
    canonical,
    h1: extractHeadings('h1'),
    h2: extractHeadings('h2'),
    imagesTotal,
    imagesWithAlt,
    wordCount,
    lang,
    hreflang,
    socialLinks,
  }
}

/**
 * Vérifie le certificat TLS réel de l'hôte (poignée de main directe, pas
 * une API tierce) — fetch() valide déjà la chaîne de confiance (sinon la
 * requête aurait échoué), mais ne dit jamais QUAND le certificat expire.
 * Un certificat valide aujourd'hui mais expirant dans 5 jours est un vrai
 * risque d'audit que fetch() seul ne peut pas voir.
 *
 * @param {string} hostname
 * @returns {Promise<{ issuer: string, validTo: string, daysRemaining: number, authorized: boolean } | null>}
 */
function getTlsCertInfo(hostname) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (val) => { if (!settled) { settled = true; resolve(val) } }

    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate()
      const authorized = socket.authorized
      socket.end()
      if (!cert || !cert.valid_to) return finish(null)
      const validTo = new Date(cert.valid_to)
      const daysRemaining = Math.round((validTo.getTime() - Date.now()) / 86400000)
      finish({
        issuer: cert.issuer?.O || cert.issuer?.CN || 'inconnu',
        validTo: cert.valid_to,
        daysRemaining,
        authorized,
      })
    })
    socket.on('error', () => finish(null))
    socket.on('timeout', () => { socket.destroy(); finish(null) })
  })
}

/**
 * Sécurité "à la maison" : en-têtes de sécurité + contenu mixte HTTP dans
 * une page HTTPS. Aucune API externe — tout vient de la réponse HTTP déjà
 * reçue par fetch_url et du HTML déjà téléchargé.
 *
 * @param {Headers} headers
 * @param {string} html
 * @param {boolean} isHttps
 * @returns {{ isHttps: boolean, hsts: string|null, csp: string|null, xFrameOptions: string|null, xContentTypeOptions: string|null, mixedContentCount: number, mixedContentSample: string[] }}
 */
function extractSecurityHeaders(headers, html, isHttps) {
  const mixedContentSample = []
  let mixedContentCount = 0
  if (isHttps) {
    const resourceRegex = /(?:src|href)\s*=\s*["']http:\/\/([^"']+)["']/gi
    let m
    while ((m = resourceRegex.exec(html))) {
      mixedContentCount++
      if (mixedContentSample.length < 5) mixedContentSample.push('http://' + m[1])
    }
  }

  return {
    isHttps,
    hsts: headers.get('strict-transport-security') || null,
    csp: headers.get('content-security-policy') || null,
    xFrameOptions: headers.get('x-frame-options') || null,
    xContentTypeOptions: headers.get('x-content-type-options') || null,
    mixedContentCount,
    mixedContentSample,
  }
}

/**
 * Extrait et valide les blocs Schema.org (JSON-LD) d'une page — pas une
 * validation exhaustive du spec, mais détecte ce qui casse le plus
 * souvent en pratique : JSON malformé (fréquent, invisible sans outil) et
 * champs requis manquants pour les types les plus courants.
 *
 * @param {string} html
 * @returns {{ count: number, schemas: Array<{ type: string|null, valid: boolean, error: string|null, issues: string[] }> }}
 */
function extractSchemaData(html) {
  const blocks = []
  const scriptRegex = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = scriptRegex.exec(html))) {
    const raw = m[1].trim()
    try {
      blocks.push({ valid: true, parsed: JSON.parse(raw), error: null })
    } catch (e) {
      blocks.push({ valid: false, parsed: null, error: e.message })
    }
  }

  const schemas = []
  for (const block of blocks) {
    if (!block.valid) {
      schemas.push({ type: null, valid: false, error: block.error, issues: [] })
      continue
    }
    const items = Array.isArray(block.parsed) ? block.parsed : (block.parsed['@graph'] || [block.parsed])
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const type = item['@type'] || 'inconnu'
      const issues = []
      if (/organization/i.test(String(type)) && !item.name) issues.push('champ "name" manquant')
      if (/product/i.test(String(type)) && !item.name) issues.push('champ "name" manquant')
      if (/article/i.test(String(type)) && !item.headline) issues.push('champ "headline" manquant')
      if (/article/i.test(String(type)) && !item.datePublished) issues.push('champ "datePublished" manquant')
      if (!item['@context']) issues.push('champ "@context" manquant')
      schemas.push({ type: String(type), valid: issues.length === 0, error: null, issues })
    }
  }

  return { count: schemas.length, schemas }
}

/**
 * Signatures de détection de stack technique (façon Wappalyzer, en plus
 * limité) : motifs regex sur le HTML déjà téléchargé — CMS, e-commerce,
 * analytics/tracking, chat. C'est le "technographics" que réclame le
 * plugin data-enrichment-master, construit sans aucune API externe.
 */
const TECH_SIGNATURES = [
  { name: 'WordPress', category: 'CMS', test: (html) => /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i.test(html) || /\/wp-content\//.test(html) || /\/wp-includes\//.test(html) },
  { name: 'Shopify', category: 'CMS / E-commerce', test: (html, headers) => /cdn\.shopify\.com/i.test(html) || /Shopify\.theme/i.test(html) || !!headers.get('x-shopid') },
  { name: 'PrestaShop', category: 'CMS / E-commerce', test: (html) => /<meta[^>]+name=["']generator["'][^>]+content=["']PrestaShop/i.test(html) || /prestashop/i.test(html) },
  { name: 'WooCommerce', category: 'E-commerce', test: (html) => /woocommerce/i.test(html) },
  { name: 'Magento', category: 'CMS / E-commerce', test: (html) => /Mage\.Cookies/i.test(html) || /\/skin\/frontend\//.test(html) },
  { name: 'Wix', category: 'CMS', test: (html) => /static\.wixstatic\.com/i.test(html) || /\bwix\.com\b/i.test(html) },
  { name: 'Webflow', category: 'CMS', test: (html) => /data-wf-site=/i.test(html) || /\bwebflow\.com\b/i.test(html) },
  { name: 'Squarespace', category: 'CMS', test: (html) => /\bsquarespace\.com\b/i.test(html) || /Squarespace\.SITE/i.test(html) },
  { name: 'Drupal', category: 'CMS', test: (html) => /Drupal\.settings/i.test(html) || /\/sites\/default\/files\//.test(html) },
  { name: 'Joomla', category: 'CMS', test: (html) => /<meta[^>]+name=["']generator["'][^>]+content=["']Joomla/i.test(html) },

  { name: 'Google Analytics (GA4)', category: 'Analytics', test: (html) => /gtag\(/i.test(html) && /\bG-[A-Z0-9]{6,}\b/.test(html) },
  { name: 'Google Analytics (Universal)', category: 'Analytics', test: (html) => /\bUA-\d{4,}-\d+\b/.test(html) },
  { name: 'Google Tag Manager', category: 'Analytics', test: (html) => /\bGTM-[A-Z0-9]+\b/.test(html) },
  { name: 'Meta/Facebook Pixel', category: 'Analytics', test: (html) => /connect\.facebook\.net\/[^"']+\/fbevents\.js/i.test(html) || /fbq\(\s*['"]init['"]/i.test(html) },
  { name: 'Hotjar', category: 'Analytics', test: (html) => /static\.hotjar\.com/i.test(html) },
  { name: 'HubSpot', category: 'Marketing Automation', test: (html) => /js\.hs-(scripts|forms|analytics)\.net/i.test(html) || /js\.hsforms\.net/i.test(html) },
  { name: 'Mailchimp', category: 'Email Marketing', test: (html) => /chimpstatic\.com/i.test(html) || /list-manage\.com/i.test(html) },
  { name: 'Klaviyo', category: 'Email Marketing', test: (html) => /static\.klaviyo\.com/i.test(html) },

  { name: 'Intercom', category: 'Chat', test: (html) => /widget\.intercom\.io/i.test(html) },
  { name: 'Drift', category: 'Chat', test: (html) => /js\.driftt\.com/i.test(html) },
  { name: 'Crisp', category: 'Chat', test: (html) => /client\.crisp\.chat/i.test(html) },
  { name: 'Tawk.to', category: 'Chat', test: (html) => /embed\.tawk\.to/i.test(html) },
  { name: 'Zendesk Chat', category: 'Chat', test: (html) => /static\.zdassets\.com/i.test(html) },
]

/**
 * @param {string} html
 * @param {Headers} headers
 * @returns {{ detected: Array<{ name: string, category: string }>, serverHeader: string|null, poweredBy: string|null }}
 */
function detectTechStack(html, headers) {
  const detected = []
  for (const sig of TECH_SIGNATURES) {
    try {
      if (sig.test(html, headers)) detected.push({ name: sig.name, category: sig.category })
    } catch {
      // Une signature qui plante ne doit jamais faire échouer les autres.
    }
  }
  return {
    detected,
    serverHeader: headers.get('server') || null,
    poweredBy: headers.get('x-powered-by') || null,
  }
}

/**
 * Détecte et parse un sitemap XML (standard sitemaps.org, utilisé tel
 * quel par WordPress/Yoast, PrestaShop, Shopify... — le format est un
 * standard, pas propre à un CMS, donc un seul parser générique couvre
 * n'importe quel site). Gère les deux variantes :
 *  - index de sitemaps (<sitemapindex><sitemap><loc>...)
 *  - sitemap de pages (<urlset><url><loc>...<lastmod>...)
 *
 * @param {string} xml
 * @returns {{ isIndex: boolean, entries: Array<{ url: string, lastmod: string|null }>, total: number } | null}
 */
function extractSitemapData(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml)
  const isUrlset = /<urlset[\s>]/i.test(xml)
  if (!isIndex && !isUrlset) return null

  const blockRegex = isIndex ? /<sitemap>([\s\S]*?)<\/sitemap>/gi : /<url>([\s\S]*?)<\/url>/gi
  const entries = []
  let total = 0
  let m
  while ((m = blockRegex.exec(xml))) {
    total++
    if (entries.length >= 200) continue // on garde un aperçu exploitable, pas un dump de 10 000 URLs
    const block = m[1]
    const loc = block.match(/<loc>([^<]*)<\/loc>/i)
    const lastmod = block.match(/<lastmod>([^<]*)<\/lastmod>/i)
    if (loc) entries.push({ url: loc[1].trim(), lastmod: lastmod ? lastmod[1].trim() : null })
  }

  return { isIndex, entries, total }
}

/**
 * Détecte et parse un flux RSS 2.0 ou Atom (blogs, actualités) — même
 * intérêt que le sitemap : de nombreux CMS l'exposent nativement
 * (WordPress à /feed/, la plupart des blogs à /rss.xml ou /atom.xml).
 * Utile pour observer la cadence de publication d'un concurrent sans
 * dépendre d'un scraping fragile de la page HTML du blog.
 *
 * @param {string} xml
 * @returns {{ format: 'rss'|'atom', title: string, items: Array<{ title: string, link: string, date: string|null }>, total: number } | null}
 */
function extractFeedData(xml) {
  const isRss = /<rss[\s>]/i.test(xml) || /<channel[\s>]/i.test(xml)
  const isAtom = /<feed[\s>]/i.test(xml) && /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xml)
  if (!isRss && !isAtom) return null

  const stripCdata = (s) => s ? s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim() : ''
  const titleMatch = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const feedTitle = titleMatch ? stripCdata(titleMatch[1]) : ''

  const items = []
  const blockRegex = isAtom ? /<entry>([\s\S]*?)<\/entry>/gi : /<item>([\s\S]*?)<\/item>/gi
  let m
  let total = 0
  while ((m = blockRegex.exec(xml))) {
    total++
    if (items.length >= 30) continue
    const block = m[1]
    const t = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const date = block.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i)
    let link = null
    if (isAtom) {
      const linkTag = block.match(/<link\s+[^>]*href\s*=\s*(["'])(.*?)\1[^>]*\/?>/i)
      link = linkTag ? linkTag[2].trim() : null
    } else {
      const linkTag = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)
      link = linkTag ? stripCdata(linkTag[1]) : null
    }
    items.push({ title: t ? stripCdata(t[1]) : '(sans titre)', link, date: date ? date[1].trim() : null })
  }

  return { format: isAtom ? 'atom' : 'rss', title: feedTitle, items, total }
}

/**
 * Récupère une URL en texte lisible, avec protections SSRF.
 * Lève une erreur explicite (jamais une exception opaque) en cas de refus
 * ou d'échec — le texte de l'erreur est renvoyé tel quel au modèle
 * appelant, qui doit pouvoir s'adapter (ex: dire qu'il n'a pas pu vérifier).
 *
 * @param {string} rawUrl
 * @param {number} [redirectsLeft]
 * @param {Array<{ from: string, to: string, status: number }>} [redirectChain] - accumulé au fil des sauts, jamais à passer manuellement
 * @returns {Promise<{ title: string, text: string, finalUrl: string, seo: ReturnType<typeof extractSeoData>|null, sitemap: ReturnType<typeof extractSitemapData>|null, security: ReturnType<typeof extractSecurityHeaders>|null, schemaOrg: ReturnType<typeof extractSchemaData>|null, tls: Awaited<ReturnType<typeof getTlsCertInfo>>, redirectChain: Array<object> }>}
 */
export async function fetchUrlSafely(rawUrl, redirectsLeft = MAX_REDIRECTS, redirectChain = []) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`URL invalide : "${rawUrl}"`)
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Protocole non autorisé : "${url.protocol}" (http/https uniquement)`)
  }

  await _resolveAndCheckPublic(url.hostname)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response
  try {
    response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Pactelys-GTM-Agent/1.0' },
    })
  } catch (err) {
    throw new Error(`Échec de la requête vers "${url}" : ${err.message}`)
  } finally {
    clearTimeout(timeout)
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirectsLeft <= 0) throw new Error(`Trop de redirections depuis "${rawUrl}"`)
    const location = response.headers.get('location')
    if (!location) throw new Error(`Redirection sans en-tête Location depuis "${url}"`)
    const nextUrl = new URL(location, url)
    // Code exact (301 permanent vs 302 temporaire) conservé à chaque saut —
    // c'était perdu avant (seule l'URL finale était renvoyée), alors que
    // c'est précisément ce qu'un audit SEO doit vérifier (ex: www -> non-www
    // en 301 propre ou en 302 fragile).
    redirectChain.push({ from: url.toString(), to: nextUrl.toString(), status: response.status })
    return fetchUrlSafely(nextUrl.toString(), redirectsLeft - 1, redirectChain)
  }

  if (!response.ok) {
    throw new Error(`"${url}" a répondu HTTP ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || ''
  const isHtml = contentType.includes('html')
  const isPlainText = contentType.includes('text/plain')
  // "xml" seul (pas "text/xml" strict) : couvre text/xml, application/xml,
  // application/rss+xml, et les sitemaps servis sans charset précis —
  // bug réel trouvé en test (sitemap refusé car content-type: text/xml).
  const isXml = contentType.includes('xml')
  if (!isHtml && !isPlainText && !isXml) {
    throw new Error(`Type de contenu non supporté pour "${url}" : ${contentType || 'inconnu'} (types acceptés : HTML, texte, XML/sitemap)`)
  }

  const buf = await response.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`Page trop volumineuse ("${url}", > ${MAX_BYTES} octets)`)
  }

  const raw = Buffer.from(buf).toString('utf-8')

  if (isXml) {
    const sitemap = extractSitemapData(raw)
    const empty = { seo: null, sitemap, feed: null, security: null, schemaOrg: null, techStack: null, tls: null, redirectChain }
    if (sitemap) {
      return { title: '', text: '', finalUrl: url.toString(), ...empty }
    }

    const feed = extractFeedData(raw)
    if (feed) {
      return { title: feed.title, text: '', finalUrl: url.toString(), ...empty, sitemap: null, feed }
    }

    // XML mais ni sitemap ni flux reconnu : traité comme du texte brut
    // plutôt que rejeté — mieux vaut un contenu lisible qu'un refus.
    return { title: '', text: raw.slice(0, MAX_TEXT_CHARS), finalUrl: url.toString(), ...empty, sitemap: null }
  }

  const isHttps = url.protocol === 'https:'
  const { title, text } = htmlToText(raw)
  const seo = extractSeoData(raw, text)
  const security = extractSecurityHeaders(response.headers, raw, isHttps)
  const schemaOrg = extractSchemaData(raw)
  const techStack = detectTechStack(raw, response.headers)
  const tlsInfo = isHttps ? await getTlsCertInfo(url.hostname) : null

  return { title, text, finalUrl: url.toString(), seo, sitemap: null, feed: null, security, schemaOrg, techStack, tls: tlsInfo, redirectChain }
}

const CRAWL_MAX_PAGES_DEFAULT = 30
const CRAWL_MAX_PAGES_CAP = 60
const CRAWL_TIMEOUT_MS = 8000
const CRAWL_MAX_REDIRECT_HOPS = 5

/**
 * Normalise une URL pour la déduplication du crawl : retire seulement le
 * fragment (#...). NE retire PAS le slash final : beaucoup de sites (dont
 * WordPress, très répandu) redirigent justement le sans-slash VERS le
 * avec-slash — le retirer créait une redirection artificielle sur
 * quasiment chaque page normale, qui excluait ensuite ces pages de
 * l'analyse de contenu (bug réel trouvé en test : 6 pages "thin content"
 * réelles disparaissaient du rapport). Conséquence acceptée : "/page" et
 * "/page/" peuvent être comptées comme deux entrées si le site les sert
 * réellement toutes les deux sans redirection — plus sûr qu'une
 * normalisation qui ment sur le vrai comportement HTTP du site.
 *
 * @param {URL} urlObj
 * @param {string} [_origin] - conservé pour compatibilité de signature, plus utilisé
 * @returns {string}
 */
function _normalizeCrawlUrl(urlObj, _origin) {
  urlObj.hash = ''
  return urlObj.toString()
}

/**
 * Extrait les liens internes (même origine uniquement) d'une page HTML —
 * ignore ancres, mailto/tel/javascript. C'est la base du maillage :
 * chaque lien trouvé devient un "vote" de la page source vers la cible.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @param {string} origin
 * @returns {string[]}
 */
function _extractInternalLinks(html, baseUrl, origin) {
  const links = new Set()
  const hrefRegex = /<a\s+[^>]*href\s*=\s*(["'])(.*?)\1/gi
  let m
  while ((m = hrefRegex.exec(html))) {
    const raw = m[2].trim()
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) continue
    let abs
    try { abs = new URL(raw, baseUrl) } catch { continue }
    if (abs.origin !== origin) continue
    links.add(_normalizeCrawlUrl(abs, origin))
  }
  return [...links]
}

const DUPLICATE_SIMILARITY_THRESHOLD = 0.75
const THIN_CONTENT_WORD_THRESHOLD = 200
const MIN_WORDS_FOR_DUPLICATE_CHECK = 30 // sous ce seuil, deux pages quasi vides se ressemblent toujours à tort

/**
 * Découpe un texte (déjà tokenisé en mots) en "shingles" — fenêtres
 * glissantes de N mots consécutifs. Technique standard de détection de
 * quasi-doublons : deux pages reformulées différemment mais au contenu
 * identique partagent énormément de shingles, contrairement à une simple
 * comparaison mot à mot qui ignorerait l'ordre.
 *
 * @param {string[]} words
 * @param {number} [n]
 * @returns {Set<string>}
 */
function _textShingles(words, n = 5) {
  const shingles = new Set()
  for (let i = 0; i + n <= words.length; i++) {
    shingles.add(words.slice(i, i + n).join(' '))
  }
  return shingles
}

/**
 * Similarité de Jaccard entre deux ensembles de shingles : taille de
 * l'intersection / taille de l'union. 1.0 = contenu identique, 0 = aucun
 * shingle en commun.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number}
 */
function _jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  let intersection = 0
  for (const s of small) if (big.has(s)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Mini-crawler interne (parcours en largeur, borné) — pas un Screaming
 * Frog/Sitebulb (ça reste hors de portée gratuite), mais couvre les
 * diagnostics structurels qu'un audit page-par-page manuel ne peut
 * jamais voir : profondeur de clic, maillage interne (qui reçoit des
 * liens, qui n'en reçoit aucun), chaînes de redirection A→B→C, boucles,
 * erreurs 5xx, temps de réponse par page.
 *
 * Limite assumée : un crawl pur ne peut JAMAIS découvrir une page à 0
 * lien entrant (par construction, on ne la trouve qu'en suivant un lien
 * vers elle). La vraie détection de pages orphelines nécessite de
 * comparer avec une liste externe — `sitemapUrl` sert exactement à ça :
 * toute URL présente dans le sitemap mais jamais atteinte par le crawl
 * est une vraie page orpheline.
 *
 * @param {string} startUrl
 * @param {number} [maxPages]
 * @param {string} [sitemapUrl]
 * @returns {Promise<object>}
 */
export async function crawlSite(startUrl, maxPages = CRAWL_MAX_PAGES_DEFAULT, sitemapUrl = null) {
  let start
  try {
    start = new URL(startUrl)
  } catch {
    throw new Error(`URL invalide : "${startUrl}"`)
  }
  if (!['http:', 'https:'].includes(start.protocol)) {
    throw new Error(`Protocole non autorisé : "${start.protocol}" (http/https uniquement)`)
  }

  const cappedMax = Math.min(Math.max(1, maxPages || CRAWL_MAX_PAGES_DEFAULT), CRAWL_MAX_PAGES_CAP)
  // `let`, pas `const` : si la page de départ redirige (ex: www -> non-www,
  // cas très courant), l'origine réelle du site n'est connue qu'après ce
  // premier saut — voir la correction juste après la résolution du premier
  // hop plus bas. Sans ça, tous les liens de la page réelle semblent
  // "externes" (origine différente) et le crawl s'arrête après 1 page —
  // bug réel trouvé en test sur pactelys.fr.
  let origin = start.origin
  const startNormalized = _normalizeCrawlUrl(start, origin)

  /** @type {Map<string, { depth: number, status: number|null, error: string|null, responseTimeMs: number|null, redirectChain: Array<object>, finalUrl: string, incomingLinks: Set<string>, outgoingCount: number|null, crawled: boolean }>} */
  const pages = new Map()
  pages.set(startNormalized, { depth: 0, status: null, error: null, responseTimeMs: null, redirectChain: [], finalUrl: startNormalized, incomingLinks: new Set(), outgoingCount: null, crawled: false })

  // Contenu textuel par page (mots + shingles) pour la détection de contenu
  // dupliqué/thin content APRÈS le crawl — texte déjà téléchargé pendant le
  // crawl, aucune requête réseau en plus.
  const contentMap = new Map()

  const queue = [{ url: startNormalized, depth: 0 }]
  const queued = new Set([startNormalized])
  let crawledCount = 0

  while (queue.length && crawledCount < cappedMax) {
    const { url, depth } = queue.shift()
    const pageStart = Date.now()

    let currentUrl = url
    let hops = 0
    const redirectChain = []
    const seenInChain = new Set([currentUrl])
    let finalResponse = null
    let fetchError = null

    while (hops < CRAWL_MAX_REDIRECT_HOPS) {
      let u
      try {
        u = new URL(currentUrl)
      } catch {
        fetchError = 'URL invalide rencontrée pendant le suivi de redirection'
        break
      }
      try {
        await _resolveAndCheckPublic(u.hostname)
      } catch (e) {
        fetchError = e.message
        break
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS)
      let response
      try {
        response = await fetch(u.toString(), {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': 'Pactelys-GTM-Agent/1.0' },
        })
      } catch (e) {
        fetchError = `Échec réseau : ${e.message}`
        clearTimeout(timeout)
        break
      }
      clearTimeout(timeout)

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) { fetchError = 'Redirection sans en-tête Location'; break }
        const nextUrl = new URL(location, u)
        const nextStr = nextUrl.toString()
        if (seenInChain.has(nextStr)) { fetchError = 'Boucle de redirection détectée'; break }
        seenInChain.add(nextStr)
        redirectChain.push({ from: currentUrl, to: nextStr, status: response.status })
        currentUrl = nextStr
        hops++
        continue
      }

      finalResponse = response
      break
    }

    if (!finalResponse && !fetchError) fetchError = `Trop de sauts de redirection (>${CRAWL_MAX_REDIRECT_HOPS})`

    const responseTimeMs = Date.now() - pageStart
    crawledCount++

    if (fetchError) {
      const existing = pages.get(url)
      pages.set(url, { depth, status: null, error: fetchError, responseTimeMs, redirectChain, finalUrl: currentUrl, incomingLinks: existing?.incomingLinks || new Set(), outgoingCount: null, crawled: true })
      continue
    }

    // La page de départ redirige (ex: www -> non-www) : on aligne l'origine
    // du crawl sur la destination réelle AVANT d'extraire ses liens, sinon
    // ils semblent tous "externes" (voir note plus haut).
    if (url === startNormalized && currentUrl !== url) {
      try { origin = new URL(currentUrl).origin } catch { /* garde l'origine de départ si l'URL finale est étrangement invalide */ }
    }

    const status = finalResponse.status
    const contentType = finalResponse.headers.get('content-type') || ''
    const isHtml = contentType.includes('html')

    let links = []
    if (isHtml && status >= 200 && status < 300) {
      try {
        const buf = await finalResponse.arrayBuffer()
        if (buf.byteLength <= MAX_BYTES) {
          const html = Buffer.from(buf).toString('utf-8')
          links = _extractInternalLinks(html, currentUrl, origin)
          // Une page qui redirige n'a pas de contenu "à elle" : son texte
          // EST celui de sa destination, qui sera de toute façon analysée
          // séparément (souvent dans ce même crawl). Sans cette exclusion,
          // www.site.fr et site.fr se comparaient à 100% "similaires" —
          // faux doublon trouvé en test, ce n'est qu'une seule page.
          if (redirectChain.length === 0) {
            const { text } = htmlToText(html)
            const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
            contentMap.set(url, { wordCount: words.length, shingles: _textShingles(words) })
          }
        }
      } catch {
        // Extraction de liens/contenu non bloquante — la page reste comptabilisée même si ça échoue.
      }
    }

    const existing = pages.get(url)
    pages.set(url, {
      depth,
      status,
      error: null,
      responseTimeMs,
      redirectChain,
      finalUrl: currentUrl,
      incomingLinks: existing?.incomingLinks || new Set(),
      outgoingCount: links.length,
      crawled: true,
    })

    for (const link of links) {
      const target = pages.get(link) || { depth: depth + 1, status: null, error: null, responseTimeMs: null, redirectChain: [], finalUrl: link, incomingLinks: new Set(), outgoingCount: null, crawled: false }
      target.incomingLinks.add(url)
      pages.set(link, target)

      if (!queued.has(link) && crawledCount + queue.length < cappedMax) {
        queue.push({ url: link, depth: depth + 1 })
        queued.add(link)
      }
    }
  }

  // Détection des vraies pages orphelines : comparaison avec le sitemap
  // si fourni (seule façon fiable — voir la note dans le docstring).
  let orphanPages = null
  if (sitemapUrl) {
    try {
      const sitemapResult = await fetchUrlSafely(sitemapUrl)
      if (sitemapResult.sitemap && !sitemapResult.sitemap.isIndex) {
        orphanPages = sitemapResult.sitemap.entries
          .map(e => e.url)
          .filter(u => {
            try {
              const abs = new URL(u)
              if (abs.origin !== origin) return false
              return !pages.has(_normalizeCrawlUrl(abs, origin))
            } catch { return false }
          })
      } else if (sitemapResult.sitemap?.isIndex) {
        orphanPages = { error: 'sitemapUrl pointe vers un INDEX de sitemaps, pas un sitemap de pages — fournis directement l\'URL d\'un des sitemaps listés dedans (ex: page-sitemap1.xml).' }
      }
    } catch (e) {
      orphanPages = { error: `Sitemap inaccessible : ${e.message}` }
    }
  }

  // Contenu dupliqué / thin content — calculé sur le texte déjà récupéré
  // pendant le crawl, aucune requête réseau supplémentaire. Comparaison
  // par paires (borné à cappedMax pages, donc au pire ~1800 comparaisons
  // pour 60 pages — trivial en calcul).
  const contentEntries = [...contentMap.entries()].filter(([, c]) => c.wordCount >= MIN_WORDS_FOR_DUPLICATE_CHECK)
  const duplicatePairs = []
  for (let i = 0; i < contentEntries.length; i++) {
    for (let j = i + 1; j < contentEntries.length; j++) {
      const [urlA, dataA] = contentEntries[i]
      const [urlB, dataB] = contentEntries[j]
      const similarity = _jaccardSimilarity(dataA.shingles, dataB.shingles)
      if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
        duplicatePairs.push({ urlA, urlB, similarityPercent: Math.round(similarity * 100) })
      }
    }
  }
  const thinContentPages = [...contentMap.entries()]
    .filter(([, c]) => c.wordCount < THIN_CONTENT_WORD_THRESHOLD)
    .map(([url, c]) => ({ url, wordCount: c.wordCount }))
    .sort((a, b) => a.wordCount - b.wordCount)

  const pageList = [...pages.entries()].map(([url, data]) => ({
    url,
    depth: data.depth,
    status: data.status,
    error: data.error,
    responseTimeMs: data.responseTimeMs,
    redirectHops: data.redirectChain.length,
    redirectChain: data.redirectChain,
    incomingLinksCount: data.incomingLinks.size,
    outgoingLinksCount: data.outgoingCount,
    crawled: data.crawled,
  }))

  return {
    startUrl: startNormalized,
    maxPages: cappedMax,
    pagesDiscovered: pageList.length,
    pagesCrawled: pageList.filter(p => p.crawled).length,
    pagesNotCrawled: pageList.filter(p => !p.crawled).length, // limite de pages atteinte avant de les explorer
    orphanPages, // null si sitemapUrl non fourni, sinon liste des vraies orphelines (ou {error})
    duplicatePairs, // paires de pages dont le contenu se recoupe à >= 75% (shingles de 5 mots)
    thinContentPages, // pages avec moins de 200 mots de texte visible, triées par ordre croissant
    pages: pageList,
  }
}

/**
 * Vérifie qu'un domaine peut réellement recevoir des emails (enregistrements
 * MX valides) — un simple lookup DNS, aucune API tierce. Sert à confirmer
 * qu'un domaine de prospection est vivant et correctement configuré avant
 * de le considérer comme une piste sérieuse, plutôt que de le supposer.
 *
 * @param {string} domain
 * @returns {Promise<{ domain: string, hasMx: boolean, mxRecords: Array<{ exchange: string, priority: number }>, error: string|null }>}
 */
export async function checkDomainEmail(domain) {
  const clean = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '')
  if (!clean || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) {
    throw new Error(`Domaine invalide : "${domain}"`)
  }

  try {
    const records = await dns.resolveMx(clean)
    const sorted = records.sort((a, b) => a.priority - b.priority)
    return { domain: clean, hasMx: sorted.length > 0, mxRecords: sorted, error: null }
  } catch (err) {
    // ENOTFOUND / ENODATA = domaine sans MX (ou inexistant) : ce n'est pas
    // une panne de l'outil, c'est le résultat lui-même — pas d'exception.
    return { domain: clean, hasMx: false, mxRecords: [], error: err.code === 'ENOTFOUND' ? 'Domaine introuvable' : (err.code || err.message) }
  }
}
