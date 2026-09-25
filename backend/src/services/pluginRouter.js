/**
 * services/pluginRouter.js — Sélection dynamique de plugin/agent/skill
 * parmi le catalogue gtm-agents-main, façon Claude Code : une liste
 * compacte nom+description (les tables docs/*.md déjà générées dans le
 * repo) sert de "menu" à un appel DeepSeek, qui choisit la séquence
 * d'agents la plus pertinente pour une demande en texte libre. Le
 * contenu complet (agent .md + skill(s) .md) n'est lu sur disque
 * qu'APRÈS la sélection — progressive disclosure, comme les skills.
 *
 * Ne dépend pas de la base de données : le catalogue vient des fichiers
 * markdown du repo (montés en lecture seule dans le conteneur), le
 * contenu des agents/skills aussi.
 */

import fs from 'fs/promises'
import path from 'path'
import claudeBrain from './claudeBrain.js'

const GTM_AGENTS_DIR = process.env.GTM_AGENTS_DIR || '/app/gtm-agents-main'
const ROUTER_MODEL_DEEPSEEK = 'deepseek-v4-pro'
// Routage = classification JSON bon marché : haiku suffit largement, pas
// besoin de sonnet/opus pour choisir 1-3 agents dans un catalogue fourni.
const ROUTER_MODEL_CLAUDE = 'claude-haiku-4-5-20251001'

let _catalogCache = null

/**
 * Parse les lignes d'un tableau markdown (`| a | b | c |`), sans la
 * ligne d'en-tête ni la ligne de séparation (`|---|---|`).
 *
 * @param {string} markdown
 * @returns {string[][]}
 */
function parseTableRows(markdown) {
  const rows = []
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.slice(1, -1).split('|').map(c => c.trim())
    if (cells.every(c => /^:?-+:?$/.test(c))) continue
    rows.push(cells)
  }
  return rows.slice(1) // la première ligne restante est l'en-tête
}

/**
 * Charge et parse une seule fois (cache mémoire process) les 3 tables
 * catalogue déjà générées dans gtm-agents-main/docs/.
 *
 * @returns {Promise<{ plugins: object[], agents: object[], skills: object[], pluginsMd: string, agentsMd: string, skillsMd: string }>}
 */
async function loadCatalog() {
  if (_catalogCache) return _catalogCache

  const [pluginsMd, agentsMd, skillsMd] = await Promise.all([
    fs.readFile(path.join(GTM_AGENTS_DIR, 'docs/plugin-reference.md'), 'utf-8'),
    fs.readFile(path.join(GTM_AGENTS_DIR, 'docs/agent-reference.md'), 'utf-8'),
    fs.readFile(path.join(GTM_AGENTS_DIR, 'docs/business-skills.md'), 'utf-8'),
  ])

  const plugins = parseTableRows(pluginsMd).map(([name, category, description]) => ({ name, category, description }))
  const agents = parseTableRows(agentsMd).map(([plugin, agent, model, description, filePath]) => ({ plugin, agent, model, description, path: filePath }))
  const skills = parseTableRows(skillsMd).map(([plugin, skill, description, filePath]) => ({ plugin, skill, description, path: filePath }))

  _catalogCache = { plugins, agents, skills, pluginsMd, agentsMd, skillsMd }
  return _catalogCache
}

const ROUTER_INSTRUCTIONS = `Tu es le routeur d'un système GTM multi-agents. Un client décrit une demande en texte libre.
Ton rôle : choisir, dans le catalogue ci-dessous (plugins / agents / skills réels), la séquence d'1 à 3 agents la plus pertinente pour traiter cette demande — comme un manager GTM assignerait la tâche aux bonnes personnes de son équipe, dans le bon ordre (ex: un stratège cadre le travail avant qu'un rédacteur ne produise le livrable).

RÈGLES STRICTES :
- N'invente JAMAIS un plugin, un agent ou un skill : utilise EXACTEMENT les noms qui apparaissent dans le catalogue fourni.
- Le "plugin" d'un agent/skill choisi doit correspondre à celui indiqué dans sa ligne de tableau.
- Réponds UNIQUEMENT avec un tableau JSON, sans texte autour, sans bloc markdown \`\`\`.

Format de sortie attendu (tableau JSON, 1 à 3 éléments, dans l'ordre d'exécution) :
[
  { "plugin": "content-marketing", "agent": "content-strategist", "skills": [], "reason": "Cadre l'angle et le brief avant rédaction." },
  { "plugin": "content-marketing", "agent": "blog-writer", "skills": ["seo-writing"], "reason": "Rédige l'article SEO final à partir du brief." }
]`

/**
 * Extrait un JSON valide d'une réponse LLM qui peut contenir du texte
 * ou des barrières ```json autour du JSON attendu.
 *
 * @param {string} text
 * @returns {any}
 */
function extractJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) {
      try { return JSON.parse(fenced[1]) } catch { /* fallthrough */ }
    }
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1))
    }
    throw new Error(`Réponse du routeur non-JSON : ${text.slice(0, 300)}`)
  }
}

/**
 * Vérifie qu'un step renvoyé par le routeur correspond bien à un
 * agent/skill réel du catalogue (le LLM peut halluciner un nom).
 *
 * @param {object} catalog
 * @param {{ plugin: string, agent: string, skills?: string[] }} step
 * @returns {{ agentRow: object, skillRows: object[] } | { error: string }}
 */
function resolveStep(catalog, step) {
  const agentRow = catalog.agents.find(
    a => a.plugin === step.plugin && a.agent.toLowerCase() === String(step.agent || '').toLowerCase()
  )
  if (!agentRow) {
    return { error: `Agent "${step.agent}" introuvable dans le plugin "${step.plugin}" — vérifie le catalogue.` }
  }

  const skillRows = []
  for (const skillName of (step.skills || [])) {
    const skillRow = catalog.skills.find(
      s => s.plugin === step.plugin && s.skill.toLowerCase() === String(skillName).toLowerCase()
    )
    if (skillRow) skillRows.push(skillRow)
    // Un skill non trouvé est silencieusement ignoré (non bloquant) :
    // l'agent reste utilisable sans ce complément de connaissance.
  }

  return { agentRow, skillRows }
}

/**
 * Retire le frontmatter YAML (--- ... ---) d'un fichier .md.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripFrontmatter(raw) {
  if (raw.startsWith('---')) {
    const parts = raw.split('---')
    if (parts.length >= 3) return parts.slice(2).join('---').trim()
  }
  return raw.trim()
}

/**
 * Lit un champ simple (`clé: valeur` sur une seule ligne) dans le
 * frontmatter YAML d'un fichier .md — suffisant ici (pas besoin d'un vrai
 * parseur YAML) puisque `description` est toujours une ligne simple dans
 * les commandes gtm-agents-main.
 *
 * @param {string} raw
 * @param {string} field
 * @returns {string|null}
 */
function parseFrontmatterField(raw, field) {
  if (!raw.startsWith('---')) return null
  const parts = raw.split('---')
  if (parts.length < 3) return null
  const match = parts[1].match(new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm'))
  return match ? match[1].trim() : null
}

/**
 * Même bloc que scripts/build_prompt_templates.py::CLIENT_CONTEXT_BLOCK —
 * placeholders résolus ensuite par execute.js::_injectMarkdownFiles avec
 * le contenu réel du client. Sans ce bloc, l'agent/skill choisi ne voit
 * JAMAIS Brand.md/S01.md/CLAUDE.md : les placeholders qu'_injectMarkdownFiles
 * cherche à remplacer n'existent pas dans les fichiers bruts de gtm-agents-main.
 */
const CLIENT_CONTEXT_BLOCK = `

CONTEXTE CLIENT — SOURCE DE VÉRITÉ, À RESPECTER STRICTEMENT
--- Brand.md ---
{{BRAND_MD}}
--- S01.md (ICP) ---
{{S01_MD}}
--- Règles complémentaires (CLAUDE.md) ---
{{CLAUDE_MD}}
`

/**
 * Lit sur disque le contenu complet de l'agent + des skills choisis
 * pour une étape, et les assemble en un seul bloc de texte.
 *
 * @param {object} agentRow
 * @param {object[]} skillRows
 * @returns {Promise<string>}
 */
async function loadStepContent(agentRow, skillRows) {
  const agentRaw = await fs.readFile(path.join(GTM_AGENTS_DIR, agentRow.path), 'utf-8')
  const pieces = [`--- AGENT : ${agentRow.agent} ---\n${stripFrontmatter(agentRaw)}`]

  for (const skillRow of skillRows) {
    const skillRaw = await fs.readFile(path.join(GTM_AGENTS_DIR, skillRow.path), 'utf-8')
    pieces.push(`--- SKILL : ${skillRow.skill} ---\n${stripFrontmatter(skillRaw)}`)
  }

  return pieces.join('\n\n') + CLIENT_CONTEXT_BLOCK
}

/**
 * Route une demande client en texte libre vers 1-3 étapes agent/skill
 * réelles du catalogue gtm-agents-main, et charge leur contenu complet.
 *
 * @param {string} userInput - demande du client, texte libre
 * @param {string} [clientContext] - résumé optionnel (secteur, ICP...)
 * @param {'deepseek'|'claude'} [provider] - défaut 'deepseek', comportement inchangé si omis
 * @returns {Promise<{ steps: Array<{ plugin: string, agent: string, model: string, skills: string[], reason: string, promptBody: string }>, rawDecision: any }>}
 */
async function routeRequest(userInput, clientContext = '', provider = 'deepseek') {
  const catalog = await loadCatalog()

  const systemPrompt = [
    ROUTER_INSTRUCTIONS,
    '## Plugins disponibles\n' + catalog.pluginsMd,
    '## Agents disponibles\n' + catalog.agentsMd,
    '## Skills disponibles\n' + catalog.skillsMd,
  ].join('\n\n')

  const userMessage = [
    clientContext ? `Contexte client :\n${clientContext}` : '',
    `Demande du client : ${userInput}`,
  ].filter(Boolean).join('\n\n')

  const routerModel = provider === 'claude' ? ROUTER_MODEL_CLAUDE : ROUTER_MODEL_DEEPSEEK
  const raw = await claudeBrain._routingCompletion(systemPrompt, userMessage, routerModel, provider)
  const decision = extractJson(raw)

  if (!Array.isArray(decision) || decision.length === 0) {
    throw new Error(`Le routeur n'a renvoyé aucune étape exploitable : ${raw.slice(0, 300)}`)
  }

  const steps = []
  for (const rawStep of decision.slice(0, 3)) {
    const resolved = resolveStep(catalog, rawStep)
    if ('error' in resolved) {
      throw new Error(`Sélection du routeur invalide : ${resolved.error}`)
    }
    const promptBody = await loadStepContent(resolved.agentRow, resolved.skillRows)
    steps.push({
      plugin: rawStep.plugin,
      agent: resolved.agentRow.agent,
      model: resolved.agentRow.model,
      skills: resolved.skillRows.map(s => s.skill),
      reason: rawStep.reason || '',
      promptBody,
    })
  }

  return { steps, rawDecision: decision }
}

const AGENT_SKILL_SELECT_INSTRUCTIONS = `Tu dois choisir, PARMI LA LISTE CI-DESSOUS UNIQUEMENT (les agents/skills d'UN SEUL plugin, pas tout le catalogue), 1 à 3 agents pertinents pour exécuter la commande précisée (façon équipe qui se répartit le travail — ex: un lead technique + un spécialiste contenu, si la commande couvre plusieurs dimensions), chacun avec 0 à 2 skills complémentaires.

RÈGLES STRICTES :
- N'utilise QUE les noms d'agents/skills listés ci-dessous — jamais un nom d'un autre plugin, jamais inventé.
- N'ajoute un agent que s'il apporte vraiment quelque chose à CETTE commande précise — ne force jamais 3 agents si 1 seul (ou 0) suffit. La plupart des commandes simples n'ont besoin que d'un seul agent.
- Si aucun agent de la liste ne correspond vraiment à cette commande, réponds avec un tableau vide plutôt que de forcer un mauvais choix (ça arrive : certaines commandes sont auto-suffisantes).
- Réponds UNIQUEMENT avec un tableau JSON, sans texte autour, sans bloc markdown \`\`\`.

Format de sortie attendu (1 à 3 éléments) :
[
  { "agent": "technical-lead", "skills": ["technical-seo"], "reason": "Pilote le crawl et le plan d'action technique." },
  { "agent": "content-optimizer", "skills": ["on-page"], "reason": "Complète l'audit côté qualité de contenu." }
]
ou, si rien ne correspond :
[]`

/**
 * Choisit 0 à 3 agents (chacun avec 0 à 2 skills) parmi CEUX DU PLUGIN DÉJÀ
 * CHOISI PAR LE CLIENT uniquement — jamais tout le catalogue (203 agents/
 * 243 skills). Complète le mode "Paramètres précis" (execute-command) :
 * le client choisit la commande de façon 100% déterministe (zéro IA sur ce
 * choix), l'IA choisit ensuite l'équipe d'agents/skills complémentaire, et
 * dans un périmètre restreint — plus cadré qu'un routage sur tout le
 * catalogue (routeRequest, utilisé par le mode texte libre), mais avec la
 * même flexibilité "1 à 3" plutôt qu'un plafond artificiel à 1 seul agent.
 *
 * Ne fait jamais échouer l'appelant : toute erreur (réseau, JSON invalide,
 * agents hallucinés) se replie silencieusement sur un tableau vide — la
 * commande reste exécutable seule dans tous les cas.
 *
 * @param {string} pluginName
 * @param {{ name: string, description: string }} commandRow
 * @param {Record<string, string>} parameters
 * @param {string} [clientContext]
 * @param {'deepseek'|'claude'} [provider]
 * @returns {Promise<Array<{ agentRow: object|null, skillRows: object[], reason: string }>>}
 */
async function selectAgentAndSkills(pluginName, commandRow, parameters, clientContext = '', provider = 'deepseek') {
  const catalog = await loadCatalog()
  const pluginAgents = catalog.agents.filter(a => a.plugin === pluginName)
  const pluginSkills = catalog.skills.filter(s => s.plugin === pluginName)

  if (pluginAgents.length === 0) {
    return [{ agentRow: null, skillRows: [], reason: `Aucun agent documenté pour le plugin "${pluginName}" — commande exécutée seule.` }]
  }

  const agentsList = pluginAgents.map(a => `- ${a.agent} : ${a.description}`).join('\n')
  const skillsList = pluginSkills.length
    ? pluginSkills.map(s => `- ${s.skill} : ${s.description}`).join('\n')
    : '(aucun skill documenté pour ce plugin)'

  const filledParams = Object.entries(parameters || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
  const paramsText = filledParams.length
    ? filledParams.map(([k, v]) => `${k}=${v}`).join(', ')
    : '(aucun paramètre rempli, valeurs par défaut)'

  const systemPrompt = [
    AGENT_SKILL_SELECT_INSTRUCTIONS,
    `## Agents disponibles pour le plugin "${pluginName}"\n${agentsList}`,
    `## Skills disponibles pour le plugin "${pluginName}"\n${skillsList}`,
  ].join('\n\n')

  const userMessage = [
    clientContext ? `Contexte client :\n${clientContext}` : '',
    `Commande à exécuter : ${commandRow.name} — ${commandRow.description}`,
    `Paramètres fournis : ${paramsText}`,
  ].filter(Boolean).join('\n\n')

  const selectModel = provider === 'claude' ? ROUTER_MODEL_CLAUDE : ROUTER_MODEL_DEEPSEEK

  let decision
  try {
    const raw = await claudeBrain._routingCompletion(systemPrompt, userMessage, selectModel, provider)
    decision = extractJson(raw)
  } catch (err) {
    return [{ agentRow: null, skillRows: [], reason: `Sélection agent/skill indisponible (${err.message}) — commande exécutée seule.` }]
  }

  if (!Array.isArray(decision) || decision.length === 0) {
    return [{ agentRow: null, skillRows: [], reason: 'Aucun agent particulièrement pertinent pour cette commande.' }]
  }

  const selections = []
  const seenAgents = new Set()
  for (const item of decision.slice(0, 3)) {
    if (!item || !item.agent) continue
    const agentRow = pluginAgents.find(a => a.agent.toLowerCase() === String(item.agent).toLowerCase())
    // Halluciné ou doublon : ignoré silencieusement, les autres agents choisis restent utilisables.
    if (!agentRow || seenAgents.has(agentRow.agent)) continue
    seenAgents.add(agentRow.agent)

    const skillRows = []
    for (const skillName of (item.skills || [])) {
      const skillRow = pluginSkills.find(s => s.skill.toLowerCase() === String(skillName).toLowerCase())
      if (skillRow) skillRows.push(skillRow)
    }
    selections.push({ agentRow, skillRows, reason: item.reason || '' })
  }

  if (selections.length === 0) {
    return [{ agentRow: null, skillRows: [], reason: 'Aucun agent valide retenu (hallucination ou aucune correspondance) — commande exécutée seule.' }]
  }

  return selections
}

/**
 * Charge le contenu complet d'une commande précise (mode manuel — l'écran
 * "catégorie > plugin > commande" de la console) et y injecte les
 * paramètres remplis par l'utilisateur. Le plugin/commande vient
 * directement du choix utilisateur — zéro IA sur CE choix-là — mais un
 * agent/skill complémentaire est ensuite choisi automatiquement via
 * selectAgentAndSkills(), restreint aux seuls agents/skills de ce plugin.
 *
 * @param {string} pluginName
 * @param {string} commandName
 * @param {Record<string, string>} [parameters] - valeurs remplies dans le formulaire, clé = nom du paramètre
 * @param {string} [clientContext] - résumé optionnel (secteur, ICP...), pour aider la sélection agent/skill
 * @param {'deepseek'|'claude'} [provider] - défaut 'deepseek'
 * @returns {Promise<{ promptBody: string, steps: Array<{ agent: string|null, skills: string[], reason: string }> }>}
 */
async function loadCommandContent(pluginName, commandName, parameters = {}, clientContext = '', provider = 'deepseek') {
  const commandPath = path.join(GTM_AGENTS_DIR, 'plugins', pluginName, 'commands', `${commandName}.md`)
  let raw
  try {
    raw = await fs.readFile(commandPath, 'utf-8')
  } catch {
    throw new Error(`Commande introuvable : "${pluginName}/${commandName}" (${commandPath})`)
  }

  const filledParams = Object.entries(parameters).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
  const paramsBlock = filledParams.length
    ? '\n\nParamètres fournis par l\'utilisateur (formulaire, pas texte libre) :\n' +
      filledParams.map(([k, v]) => `- ${k} : ${v}`).join('\n')
    : '\n\nAucun paramètre optionnel rempli — applique les valeurs par défaut documentées dans la commande.'

  const pieces = [`--- COMMANDE : ${pluginName}:${commandName} ---\n${stripFrontmatter(raw)}${paramsBlock}`]

  // Complète la commande (choisie manuellement, zéro IA sur ce choix) avec
  // 1 à 3 agents (+ skills) les plus pertinents DU MÊME PLUGIN — jamais tout
  // le catalogue. Un échec ici ne bloque jamais la commande (voir
  // selectAgentAndSkills : repli silencieux sur agentRow=null).
  const commandDescription = parseFrontmatterField(raw, 'description') || commandName
  const selections = await selectAgentAndSkills(
    pluginName,
    { name: commandName, description: commandDescription },
    parameters,
    clientContext,
    provider
  )

  for (const { agentRow, skillRows } of selections) {
    if (!agentRow) continue
    const agentRaw = await fs.readFile(path.join(GTM_AGENTS_DIR, agentRow.path), 'utf-8')
    pieces.push(`--- AGENT : ${agentRow.agent} ---\n${stripFrontmatter(agentRaw)}`)
    for (const skillRow of skillRows) {
      const skillRaw = await fs.readFile(path.join(GTM_AGENTS_DIR, skillRow.path), 'utf-8')
      pieces.push(`--- SKILL : ${skillRow.skill} ---\n${stripFrontmatter(skillRaw)}`)
    }
  }

  return {
    promptBody: pieces.join('\n\n') + CLIENT_CONTEXT_BLOCK,
    steps: selections.map(s => ({
      agent: s.agentRow ? s.agentRow.agent : null,
      skills: s.skillRows.map(sk => sk.skill),
      reason: s.reason,
    })),
  }
}

export default {
  loadCatalog,
  routeRequest,
  loadCommandContent,
}
