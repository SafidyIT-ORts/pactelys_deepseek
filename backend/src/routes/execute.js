/**
 * routes/execute.js — Route POST /v1/actions/execute
 *
 * LA PIÈCE CENTRALE : remplace les 8+ étapes n8n par 1 seul appel.
 *
 * n8n envoie juste : { task_id, org_id }
 * Fastify fait TOUT :
 *   1. Récupère la tâche depuis PostgreSQL
 *   2. Vérifie que l'action est activée pour l'organisation
 *   3. Récupère le(s) prompt template(s) (simple OU pipeline multi-étapes)
 *   4. Récupère les fichiers markdown du client (Brand.md, S01.md, CLAUDE.md)
 *   5. Injecte les variables dans le prompt ({{BRAND_MD}}, {{S01_MD}}, etc.)
 *   6. Appelle Claude (via claudeBrain.js) — gère les retries si nécessaire
 *   7. Sauvegarde le résultat dans tasks
 *   8. Renvoie la réponse propre à n8n
 *
 * POURQUOI CETTE ARCHITECTURE :
 *   - n8n = orchestrateur léger (2-3 nœuds max), pas un moteur de prompt
 *   - Fastify = cerveau — gère la logique, les erreurs, le multi-step pipeline
 *   - Zéro fragmentation : si Claude plante, Fastify renvoie une erreur claire
 *   - Les pipelines multi-étapes fonctionnent réellement (bug n8n corrigé)
 *
 * RÉSOUT LES 3 BUG IDENTIFIÉS DANS LE WORKFLOW N8N :
 *   ❌ Bug 1 : steps[0].step_order == 1 toujours vrai → corrigé : on itère sur TOUTES les étapes
 *   ❌ Bug 2 : .replaceAll() fragile sur les clés des .md → corrigé : injection serveur, clés normalisées
 *   ❌ Bug 3 : n8n appelle Claude directement → corrigé : Fastify appelle Claude, n8n ne touche plus à l'IA
 */

import claudeBrain from '../services/claudeBrain.js'
import pluginRouter from '../services/pluginRouter.js'
import { withOrgScope } from '../utils/orgContext.js'

// ============================================================
// CONSTANTES
// ============================================================

/** Clés de remplacement dans les templates, normalisées pour éviter les bugs de casse */
const PLACEHOLDER_MAP = {
  '{{BRAND_MD}}':  'brand',
  '{{S01_MD}}':    's01',
  '{{CLAUDE_MD}}': 'claude',
}

// ============================================================
// PLUGIN FASTIFY
// ============================================================

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function executeRoutes(fastify) {

  // ----------------------------------------------------------
  // POST /v1/actions/execute
  // ----------------------------------------------------------
  fastify.post('/v1/actions/execute', {
    schema: {
      tags:        ['actions'],
      summary:     'Exécute une tâche IA en bout en bout (appelé par n8n)',
      description: `
        Remplace les 8+ étapes n8n par 1 appel. Fastify fait tout en interne :
        récupération du template, injection des .md, appel Claude, sauvegarde.
        n8n reçoit juste le résultat propre et peut enchaîner l'action finale.
      `.trim(),
      body: {
        type: 'object',
        required: ['task_id', 'org_id'],
        properties: {
          task_id:  { type: 'string', format: 'uuid', description: 'ID de la tâche à exécuter' },
          org_id:   { type: 'string', format: 'uuid', description: 'ID de l\'organisation' },
          model:    { type: 'string', description: 'Modèle Claude (optionnel, surcharge le template)' },
          provider: { type: 'string', enum: ['deepseek', 'claude'], description: 'Défaut deepseek si omis.' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success:       { type: 'boolean' },
            task_id:       { type: 'string' },
            action_id:     { type: 'string' },
            status:        { type: 'string' },
            result:        { type: 'string', description: 'Résultat généré par Claude' },
            steps_executed:{ type: 'number', description: 'Nombre d\'étapes pipeline exécutées' },
            model_used:    { type: 'string' },
            duration_ms:   { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const startTime = Date.now()
    const { task_id, org_id, model: modelOverride, provider = 'deepseek' } = request.body

    const db = await fastify.pg.connect()
    try {

      // ---- 1. MARQUER LA TÂCHE EN COURS ----
      await withOrgScope(db, org_id, () => db.query(
        `UPDATE tasks SET status = 'in_progress', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [task_id, org_id]
      ))

      // ---- 2. RÉCUPÉRER LA TÂCHE ----
      const taskResult = await withOrgScope(db, org_id, () => db.query(
        `SELECT t.id, t.action_id, t.params, t.status, t.org_id
         FROM tasks t
         WHERE t.id = $1 AND t.org_id = $2`,
        [task_id, org_id]
      ))

      if (taskResult.rowCount === 0) {
        await _markTaskError(db, task_id, org_id, 'Tâche introuvable ou appartient à une autre organisation')
        return reply.code(404).send({ success: false, error: 'Tâche introuvable.' })
      }

      const task = taskResult.rows[0]

      // ---- 3. VÉRIFIER QUE L'ACTION EST ACTIVÉE POUR CETTE ORG ----
      const authCheck = await withOrgScope(db, org_id, () => db.query(
        `SELECT 1 FROM client_enabled_actions WHERE org_id = $1 AND action_id = $2`,
        [org_id, task.action_id]
      ))

      if (authCheck.rowCount === 0) {
        await _markTaskError(db, task_id, org_id, `Action "${task.action_id}" non activée pour cette organisation`)
        return reply.code(403).send({
          success: false,
          error: `Action "${task.action_id}" non activée pour votre organisation.`,
        })
      }

      // ---- 4. RÉCUPÉRER TOUS LES STEPS DU TEMPLATE (SIMPLE OU PIPELINE) ----
      // Trie par step_order ASC pour respecter l'ordre du pipeline
      const templateResult = await db.query(
        `SELECT step_order, model, tools_config, system_prompt_final
         FROM prompt_templates
         WHERE action_id = $1 AND is_active = true
         ORDER BY step_order ASC`,
        [task.action_id]
      )

      if (templateResult.rowCount === 0) {
        await _markTaskError(db, task_id, org_id, `Aucun template actif pour l'action "${task.action_id}"`)
        return reply.code(404).send({ success: false, error: `Template introuvable pour l'action "${task.action_id}".` })
      }

      const steps = templateResult.rows
      const isPipeline = steps.length > 1  // ← CORRECTION BUG N8N : on vérifie le NOMBRE d'étapes, pas steps[0]

      request.log.info({
        task_id,
        action_id: task.action_id,
        steps_count: steps.length,
        is_pipeline: isPipeline,
      }, '[Execute] Tâche démarrée')

      // ---- 5. RÉCUPÉRER LES FICHIERS MARKDOWN DU CLIENT ----
      let clientFiles
      try {
        clientFiles = await claudeBrain.readClientConfig(org_id)
      } catch (fileErr) {
        // Fallback : essayer avec les fichiers bruts en BDD si les fichiers disque sont absents
        request.log.warn({ org_id, error: fileErr.message }, '[Execute] Fichiers disque absents, fallback BDD')
        clientFiles = await _getClientFilesFromDB(db, org_id)
      }

      if (!clientFiles) {
        await _markTaskError(db, task_id, org_id, 'Impossible de récupérer les fichiers de configuration client')
        return reply.code(404).send({ success: false, error: 'Configuration client introuvable.' })
      }

      // ---- 6. EXÉCUTION DES STEPS (SIMPLE OU PIPELINE) ----
      let finalResult = null
      let lastModel = null

      // En mode pipeline, le résultat d'une étape devient l'input de la suivante
      let pipelineContext = _buildUserInput(task.params)

      for (const step of steps) {
        const model = modelOverride || step.model || 'claude-3-5-sonnet-20241022'
        lastModel = model

        // Injection des fichiers .md dans le template (CÔTÉ SERVEUR — plus de .replaceAll fragile dans n8n)
        const resolvedPrompt = _injectMarkdownFiles(step.system_prompt_final, clientFiles)

        // Construire le message utilisateur pour cette étape
        // En pipeline : le résultat précédent est ajouté au contexte
        const userMessage = isPipeline && finalResult
          ? `${pipelineContext}\n\n--- RÉSULTAT ÉTAPE PRÉCÉDENTE ---\n${finalResult}`
          : pipelineContext

        request.log.info({
          task_id,
          step_order: step.step_order,
          model,
          is_pipeline: isPipeline,
        }, `[Execute] Appel Claude — étape ${step.step_order}/${steps.length}`)

        // Appel IA via claudeBrain (gestion d'erreur interne)
        const claudeResponse = await claudeBrain.callClaudeAPI(resolvedPrompt, userMessage, model, provider)
        finalResult = claudeResponse
      }

      // ---- 7. SAUVEGARDER LE RÉSULTAT ----
      const duration = Date.now() - startTime

      await withOrgScope(db, org_id, () => db.query(
        `UPDATE tasks
         SET status = 'completed', result = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3`,
        [finalResult, task_id, org_id]
      ))

      request.log.info({
        task_id,
        action_id: task.action_id,
        steps_executed: steps.length,
        duration_ms: duration,
      }, '[Execute] Tâche complétée avec succès')

      // ---- 8. RÉPONDRE À N8N ----
      return reply.code(200).send({
        success:        true,
        task_id,
        action_id:      task.action_id,
        status:         'completed',
        result:         finalResult,
        steps_executed: steps.length,
        model_used:     lastModel,
        duration_ms:    duration,
      })

    } catch (err) {
      // Gestion d'erreur globale — marque la tâche en erreur avant de répondre
      const errorMessage = err.message || 'Erreur inconnue'
      request.log.error({ task_id, error: errorMessage, stack: err.stack }, '[Execute] Erreur critique')

      try {
        await _markTaskError(db, task_id, org_id, errorMessage)
      } catch (dbErr) {
        request.log.error({ dbErr: dbErr.message }, '[Execute] Impossible de marquer la tâche en erreur')
      }

      return reply.code(500).send({
        success: false,
        task_id,
        error:   'Erreur interne lors de l\'exécution de la tâche.',
        detail:  process.env.NODE_ENV === 'development' ? errorMessage : undefined,
      })
    } finally {
      db.release()
    }
  })

  // ----------------------------------------------------------
  // POST /v1/actions/execute-auto
  // Comme /v1/actions/execute, mais sans action_id fixe : le client
  // décrit sa demande en texte libre, et pluginRouter choisit
  // dynamiquement la séquence d'agents gtm-agents-main la plus
  // pertinente (façon Claude Code qui choisit un Skill), au lieu de
  // lire un template pré-câblé en base.
  // ----------------------------------------------------------
  fastify.post('/v1/actions/execute-auto', {
    schema: {
      tags:    ['actions'],
      summary: 'Exécute une demande en texte libre en routant dynamiquement vers le(s) bon(s) agent(s) gtm-agents-main',
      body: {
        type: 'object',
        required: ['org_id', 'user_input'],
        properties: {
          org_id:     { type: 'string', format: 'uuid' },
          user_input: { type: 'string' },
          provider:   { type: 'string', enum: ['deepseek', 'claude'], description: 'Défaut deepseek si omis.' },
        },
      },
    },
  }, async (request, reply) => {
    const { org_id, user_input, provider = 'deepseek' } = request.body

    const db = await fastify.pg.connect()
    try {
      // ---- 1. FICHIERS MARKDOWN DU CLIENT (source de vérité, inchangé) ----
      let clientFiles
      try {
        clientFiles = await claudeBrain.readClientConfig(org_id)
      } catch (fileErr) {
        request.log.warn({ org_id, error: fileErr.message }, '[ExecuteAuto] Fichiers disque absents, fallback BDD')
        clientFiles = await _getClientFilesFromDB(db, org_id)
      }
      if (!clientFiles) {
        return reply.code(404).send({ success: false, error: 'Configuration client introuvable.' })
      }

      // ---- 2. ROUTAGE DYNAMIQUE (DeepSeek choisit plugin(s)/agent(s)/skill(s)) ----
      // Fait de façon synchrone (un seul appel, quelques secondes) : le client a
      // besoin de savoir tout de suite quels agents ont été choisis.
      const clientContextSummary = (clientFiles.s01 || '').slice(0, 800)
      const { steps, rawDecision } = await pluginRouter.routeRequest(user_input, clientContextSummary, provider)

      const actionId = 'auto:' + steps.map(s => `${s.plugin}/${s.agent}`).join('>')

      const taskInsert = await withOrgScope(db, org_id, () => db.query(
        `INSERT INTO tasks (org_id, action_id, params, status) VALUES ($1, $2, $3, 'in_progress') RETURNING id`,
        [org_id, actionId, JSON.stringify({ user_input, routing: rawDecision, provider })]
      ))
      const taskId = taskInsert.rows[0].id

      request.log.info({ task_id: taskId, steps: steps.map(s => `${s.plugin}/${s.agent}`) },
        '[ExecuteAuto] Routage effectué')

      // ---- 3. RÉPONSE IMMÉDIATE ----
      // L'exécution réelle (plusieurs appels DeepSeek + outils, potentiellement
      // 1-3 minutes) se fait APRÈS avoir répondu, pour ne jamais dépendre du
      // timeout d'un proxy devant l'API (ex: Cloudflare coupe à 100s — testé
      // en usage réel, un pipeline à 2 étapes avec vérifications web le dépasse
      // largement). Le client doit poller GET /v1/actions/status/:task_id.
      reply.code(202).send({
        success:   true,
        task_id:   taskId,
        action_id: actionId,
        status:    'in_progress',
        steps:     steps.map(s => ({ plugin: s.plugin, agent: s.agent, skills: s.skills, reason: s.reason })),
      })

      // ---- 4. EXÉCUTION EN ARRIÈRE-PLAN (non attendue par la requête HTTP) ----
      _runExecuteAutoSteps(fastify, request.log, org_id, taskId, steps, clientFiles, user_input, provider)
        .catch(err => request.log.error({ task_id: taskId, error: err.message, stack: err.stack },
          '[ExecuteAuto] Erreur en arrière-plan'))

    } catch (err) {
      const errorMessage = err.message || 'Erreur inconnue'
      request.log.error({ error: errorMessage, stack: err.stack }, '[ExecuteAuto] Erreur critique')
      if (!reply.sent) {
        return reply.code(500).send({
          success: false,
          error:   'Erreur interne lors du routage ou de l\'exécution.',
          detail:  process.env.NODE_ENV === 'development' ? errorMessage : undefined,
        })
      }
    } finally {
      db.release()
    }
  })

  // ----------------------------------------------------------
  // GET /v1/actions/status/:task_id
  // Route légère pour que n8n poll le statut si besoin
  // ----------------------------------------------------------
  fastify.get('/v1/actions/status/:task_id', {
    schema: {
      tags:    ['actions'],
      summary: 'Récupère le statut d\'une tâche (polling léger pour n8n)',
    },
  }, async (request, reply) => {
    const { task_id } = request.params
    const db = await fastify.pg.connect()
    try {
      const result = await db.query(
        `SELECT id, action_id, status, result, error_message, step_results,
                created_at, updated_at
         FROM tasks WHERE id = $1`,
        [task_id]
      )
      if (result.rowCount === 0) {
        return reply.code(404).send({ success: false, error: 'Tâche introuvable.' })
      }
      const task = result.rows[0]
      const stepResults = task.step_results || []
      return reply.send({
        success:       true,
        task_id:       task.id,
        action_id:     task.action_id,
        status:        task.status,
        result:        task.status === 'completed' ? task.result : null,
        steps:         stepResults.map(s => ({ plugin: s.plugin, agent: s.agent, skills: s.skills, reason: s.reason, tool_calls: s.tool_calls })),
        error_message: task.status === 'error' ? task.error_message : null,
        created_at:    task.created_at,
        updated_at:    task.updated_at,
      })
    } finally {
      db.release()
    }
  })

  // ----------------------------------------------------------
  // POST /v1/actions/status/:task_id/cancel
  // Annulation depuis la console (bouton "Annuler" pendant l'attente).
  // Coopérative, pas préemptive : _runExecuteAutoSteps vérifie ce statut
  // ENTRE deux étapes du pipeline et s'arrête s'il le voit — l'appel IA en
  // cours au moment du clic va jusqu'à son terme (pas d'AbortController
  // sur le fetch DeepSeek/Claude, trop de refactor pour la valeur ajoutée),
  // mais toute étape suivante ne démarre jamais.
  // ----------------------------------------------------------
  fastify.post('/v1/actions/status/:task_id/cancel', {
    schema: {
      tags:    ['actions'],
      summary: 'Annule une tâche en cours (n\'interrompt pas l\'étape déjà lancée, empêche les suivantes)',
    },
  }, async (request, reply) => {
    const { task_id } = request.params
    const db = await fastify.pg.connect()
    try {
      const result = await db.query(
        `UPDATE tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status = 'in_progress' RETURNING id`,
        [task_id]
      )
      if (result.rowCount === 0) {
        return reply.code(409).send({ success: false, error: 'Tâche introuvable ou déjà terminée — impossible à annuler.' })
      }
      return reply.send({ success: true, task_id, status: 'cancelled' })
    } finally {
      db.release()
    }
  })

  // ----------------------------------------------------------
  // POST /v1/actions/execute-command
  // Mode manuel : le client choisit lui-même catégorie > plugin > commande
  // et remplit un formulaire de paramètres (voir /v1/plugin-catalog) —
  // ZÉRO routage IA sur CE choix-là, le plugin/commande demandés sont
  // exactement ceux exécutés. pluginRouter.prepareCommand() choisit ensuite
  // 1 à 3 agents + skills complémentaires, restreints aux seuls agents/
  // skills de CE plugin (jamais les 67 autres) — plus cadré qu'un routage
  // sur tout le catalogue (execute-auto). Chaque agent retenu tourne dans
  // un appel IA ISOLÉ (voir _runExecuteCommandSteps plus bas) — vraie
  // séparation de contexte, pas un seul prompt avec plusieurs personas
  // collées, avec son propre modèle (haiku/sonnet/opus, celui déclaré
  // dans le frontmatter de l'agent .md).
  // ----------------------------------------------------------
  fastify.post('/v1/actions/execute-command', {
    schema: {
      tags:    ['actions'],
      summary: 'Exécute une commande précise (plugin/commande choisis manuellement, pas de routage IA)',
      body: {
        type: 'object',
        required: ['org_id', 'plugin', 'command'],
        properties: {
          org_id:     { type: 'string', format: 'uuid' },
          plugin:     { type: 'string' },
          command:    { type: 'string' },
          parameters: { type: 'object', additionalProperties: { type: 'string' } },
          provider:   { type: 'string', enum: ['deepseek', 'claude'], description: 'Défaut deepseek si omis.' },
        },
      },
    },
  }, async (request, reply) => {
    const { org_id, plugin, command, parameters = {}, provider = 'deepseek' } = request.body

    const db = await fastify.pg.connect()
    try {
      let clientFiles
      try {
        clientFiles = await claudeBrain.readClientConfig(org_id)
      } catch (fileErr) {
        request.log.warn({ org_id, error: fileErr.message }, '[ExecuteCommand] Fichiers disque absents, fallback BDD')
        clientFiles = await _getClientFilesFromDB(db, org_id)
      }
      if (!clientFiles) {
        return reply.code(404).send({ success: false, error: 'Configuration client introuvable.' })
      }

      // Même résumé que execute-auto : donne à la sélection agent/skill un
      // peu de contexte client (secteur, ICP) sans envoyer tout S01.md.
      const clientContextSummary = (clientFiles.s01 || '').slice(0, 800)

      let commandBlock, selections
      try {
        ;({ commandBlock, selections } =
          await pluginRouter.prepareCommand(plugin, command, parameters, clientContextSummary, provider))
      } catch (err) {
        return reply.code(404).send({ success: false, error: err.message })
      }

      const actionId = `manual:${plugin}/${command}`
      const taskInsert = await withOrgScope(db, org_id, () => db.query(
        `INSERT INTO tasks (org_id, action_id, params, status) VALUES ($1, $2, $3, 'in_progress') RETURNING id`,
        [org_id, actionId, JSON.stringify({ plugin, command, parameters, provider })]
      ))
      const taskId = taskInsert.rows[0].id

      request.log.info({ task_id: taskId, plugin, command, agents: selections.map(s => s.agentRow?.agent || null) }, '[ExecuteCommand] Tâche démarrée')

      // selections peut contenir 0 à 3 agents (ou 1 entrée { agentRow: null }
      // si aucun n'a été retenu) — renderSteps() côté console affiche déjà
      // un tableau de plusieurs cartes, aucun changement requis là-bas.
      reply.code(202).send({
        success:   true,
        task_id:   taskId,
        action_id: actionId,
        status:    'in_progress',
        steps:     selections.map(s => ({ plugin, agent: s.agentRow?.agent || null, skills: s.skillRows.map(sk => sk.skill), reason: s.reason })),
      })

      // Exécution en arrière-plan — un VRAI appel IA isolé PAR AGENT (voir
      // _runExecuteCommandSteps), pas un seul prompt fourre-tout. La réponse
      // HTTP est déjà partie, le client poll GET /v1/actions/status/:id.
      const userInputBase = Object.entries(parameters).filter(([, v]) => v).length
        ? 'Exécute cette commande avec les paramètres fournis.'
        : 'Exécute cette commande avec les valeurs par défaut documentées.'
      _runExecuteCommandSteps(fastify, request.log, org_id, taskId, plugin, commandBlock, selections, clientFiles, userInputBase, provider)
        .catch(err => request.log.error({ task_id: taskId, error: err.message, stack: err.stack },
          '[ExecuteCommand] Erreur en arrière-plan'))

    } catch (err) {
      const errorMessage = err.message || 'Erreur inconnue'
      request.log.error({ error: errorMessage, stack: err.stack }, '[ExecuteCommand] Erreur critique')
      if (!reply.sent) {
        return reply.code(500).send({ success: false, error: 'Erreur interne lors de l\'exécution de la commande.', detail: process.env.NODE_ENV === 'development' ? errorMessage : undefined })
      }
    } finally {
      db.release()
    }
  })
}

// ============================================================
// HELPERS INTERNES
// ============================================================

/**
 * Injecte les fichiers .md dans un template de prompt.
 * Gère les deux formes : {{BRAND_MD}} et {{brand_md}} (insensible à la casse).
 *
 * CORRECTION DU BUG N8N : cette injection se fait serveur-side,
 * plus de .replaceAll() fragile dans un nœud Code n8n.
 *
 * @param {string} template - Le system_prompt_final avec des placeholders
 * @param {{ brand: string, s01: string, claude: string }} files - Contenu des fichiers .md
 * @returns {string} - Le prompt avec les fichiers injectés
 */
function _injectMarkdownFiles(template, files) {
  let result = template

  // Remplacement insensible à la casse pour {{BRAND_MD}}, {{brand_md}}, etc.
  result = result.replace(/\{\{BRAND_MD\}\}/gi,  files.brand  || '')
  result = result.replace(/\{\{S01_MD\}\}/gi,    files.s01    || '')
  result = result.replace(/\{\{CLAUDE_MD\}\}/gi, files.claude || '')

  // Formes alternatives parfois utilisées dans les templates GTM
  result = result.replace(/\{\{BRAND\}\}/gi,  files.brand  || '')
  result = result.replace(/\{\{ICP\}\}/gi,    files.s01    || '')
  result = result.replace(/\{\{CONFIG\}\}/gi, files.claude || '')

  return result
}

/**
 * Construit le message utilisateur depuis les params de la tâche.
 * Les params sont stockés en JSONB — on les sérialise de manière lisible.
 *
 * @param {Object} params - Paramètres JSONB de la tâche
 * @returns {string}
 */
function _buildUserInput(params) {
  if (!params) return ''
  if (typeof params === 'string') return params

  // Si params contient un champ "input" ou "user_input", l'utiliser directement
  if (params.input)      return params.input
  if (params.user_input) return params.user_input

  // Sinon, sérialiser tout le JSONB en texte lisible pour Claude
  return Object.entries(params)
    .map(([key, val]) => `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`)
    .join('\n')
}

/**
 * Fallback : récupère les fichiers markdown depuis la BDD
 * si les fichiers disque (/app/clients/{org_id}/) sont absents.
 *
 * @param {import('pg').PoolClient} db
 * @param {string} orgId
 * @returns {Promise<{ brand: string, s01: string, claude: string } | null>}
 */
async function _getClientFilesFromDB(db, orgId) {
  const result = await withOrgScope(db, orgId, () => db.query(
    `SELECT brand_md_raw, s01_md_raw, claude_md_raw
     FROM client_config
     WHERE org_id = $1`,
    [orgId]
  ))
  if (result.rowCount === 0) return null
  const row = result.rows[0]
  return {
    brand:  row.brand_md_raw  || '',
    s01:    row.s01_md_raw    || '',
    claude: row.claude_md_raw || '',
  }
}

/**
 * Marque une tâche en état d'erreur dans PostgreSQL.
 *
 * @param {import('pg').PoolClient} db
 * @param {string} taskId
 * @param {string} orgId
 * @param {string} errorMessage
 */
async function _markTaskError(db, taskId, orgId, errorMessage) {
  await withOrgScope(db, orgId, () => db.query(
    `UPDATE tasks SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
    [errorMessage, taskId, orgId]
  ))
}

/**
 * Exécute le pipeline d'agents choisi par pluginRouter et sauvegarde le
 * résultat — appelée SANS être attendue par le handler HTTP de
 * /v1/actions/execute-auto (qui a déjà répondu 202 au client). Acquiert
 * sa PROPRE connexion DB (celle de la requête d'origine est déjà relâchée
 * au moment où ceci s'exécute).
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {import('fastify').FastifyBaseLogger} log
 * @param {string} orgId
 * @param {string} taskId
 * @param {Array<object>} steps - steps résolus par pluginRouter.routeRequest
 * @param {{ brand: string, s01: string, claude: string }} clientFiles
 * @param {string} userInput
 * @param {'deepseek'|'claude'} [provider] - défaut 'deepseek', comportement inchangé si omis
 */
async function _runExecuteAutoSteps(fastify, log, orgId, taskId, steps, clientFiles, userInput, provider = 'deepseek') {
  const db = await fastify.pg.connect()
  try {
    let finalResult = null
    const stepResults = []
    let cancelled = false

    for (const step of steps) {
      // Annulation coopérative : vérifiée ENTRE deux étapes, pas pendant un
      // appel IA en cours (voir la route de cancel pour le détail du
      // compromis). Sur un pipeline à 1 étape, ce contrôle n'a pas le
      // temps d'intervenir avant la fin — attendu, pas un bug.
      const statusCheck = await db.query(`SELECT status FROM tasks WHERE id = $1`, [taskId])
      if (statusCheck.rows[0]?.status === 'cancelled') {
        cancelled = true
        log.info({ task_id: taskId, steps_done: stepResults.length }, '[ExecuteAuto] Tâche annulée par l\'utilisateur')
        break
      }

      const resolvedPrompt = _injectMarkdownFiles(step.promptBody, clientFiles)
      const userMessage = finalResult
        ? `${userInput}\n\n--- RÉSULTAT ÉTAPE PRÉCÉDENTE ---\n${finalResult}`
        : userInput

      const { text: output, toolCalls } = await claudeBrain.callAgentStep(resolvedPrompt, userMessage, step.model, provider)
      finalResult = output
      stepResults.push({
        plugin: step.plugin,
        agent:  step.agent,
        skills: step.skills,
        reason: step.reason,
        model:  step.model,
        output,
        tool_calls: toolCalls,
      })
    }

    if (cancelled) return // ne jamais écraser le statut 'cancelled' déjà posé par la route d'annulation

    // WHERE status != 'cancelled' : filet de sécurité si l'annulation arrive
    // pile entre la dernière vérification et cette écriture (fenêtre de
    // course rare mais réelle) — on ne republie jamais 'completed' par-dessus.
    await withOrgScope(db, orgId, () => db.query(
      `UPDATE tasks SET status = 'completed', result = $1, step_results = $2, updated_at = NOW()
       WHERE id = $3 AND org_id = $4 AND status != 'cancelled'`,
      [finalResult, JSON.stringify(stepResults), taskId, orgId]
    ))

    log.info({ task_id: taskId, steps_executed: steps.length }, '[ExecuteAuto] Tâche complétée (arrière-plan)')
  } catch (err) {
    await _markTaskError(db, taskId, orgId, err.message || 'Erreur inconnue')
    throw err
  } finally {
    db.release()
  }
}

/**
 * Exécute la commande choisie manuellement (execute-command) — VRAIE
 * isolation par agent, même principe que _runExecuteAutoSteps ci-dessus :
 * un appel IA SÉPARÉ par agent sélectionné (jamais un seul prompt avec
 * plusieurs personas collées), chacun avec son propre modèle (agentRow.model
 * — haiku/sonnet/opus, déjà indiqué dans le frontmatter de l'agent .md) et
 * ses propres outils, utilisés seulement si l'agent en a vraiment besoin.
 * Pipeline séquentiel : chaque étape voit le résultat de la précédente,
 * comme pour le mode texte libre. S'il n'y a aucun agent sélectionné
 * (selections == [{ agentRow: null, ... }]), une seule étape "commande
 * seule" s'exécute.
 *
 * Ajouter un outil de plus à AGENT_TOOLS (claudeBrain.js) ne demande aucun
 * changement ici : chaque étape appelle callAgentStep() normalement, qui
 * donne accès à la liste complète des outils à chaque agent.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {import('fastify').FastifyBaseLogger} log
 * @param {string} orgId
 * @param {string} taskId
 * @param {string} plugin
 * @param {string} commandBlock - texte de la commande (pluginRouter.prepareCommand)
 * @param {Array<{ agentRow: object|null, skillRows: object[], reason: string }>} selections
 * @param {{ brand: string, s01: string, claude: string }} clientFiles
 * @param {string} userInputBase - message de départ (paramètres fournis ou valeurs par défaut)
 * @param {'deepseek'|'claude'} [provider]
 */
async function _runExecuteCommandSteps(fastify, log, orgId, taskId, plugin, commandBlock, selections, clientFiles, userInputBase, provider = 'deepseek') {
  const db = await fastify.pg.connect()
  try {
    let finalResult = null
    const stepResults = []
    let cancelled = false

    for (const selection of selections) {
      const statusCheck = await db.query(`SELECT status FROM tasks WHERE id = $1`, [taskId])
      if (statusCheck.rows[0]?.status === 'cancelled') {
        cancelled = true
        log.info({ task_id: taskId, steps_done: stepResults.length }, '[ExecuteCommand] Tâche annulée par l\'utilisateur')
        break
      }

      const stepPrompt = await pluginRouter.buildCommandStepPrompt(commandBlock, selection)
      const resolvedPrompt = _injectMarkdownFiles(stepPrompt, clientFiles)
      const userMessage = finalResult
        ? `${userInputBase}\n\n--- RÉSULTAT ÉTAPE PRÉCÉDENTE ---\n${finalResult}`
        : userInputBase

      const stepModel = selection.agentRow?.model || null
      const { text: output, toolCalls } = await claudeBrain.callAgentStep(resolvedPrompt, userMessage, stepModel, provider)
      finalResult = output
      stepResults.push({
        plugin,
        agent:  selection.agentRow ? selection.agentRow.agent : null,
        skills: selection.skillRows.map(s => s.skill),
        reason: selection.reason,
        model:  stepModel || provider,
        output,
        tool_calls: toolCalls,
      })
    }

    if (cancelled) return // ne jamais écraser le statut 'cancelled' déjà posé par la route d'annulation

    await withOrgScope(db, orgId, () => db.query(
      `UPDATE tasks SET status = 'completed', result = $1, step_results = $2, updated_at = NOW()
       WHERE id = $3 AND org_id = $4 AND status != 'cancelled'`,
      [finalResult, JSON.stringify(stepResults), taskId, orgId]
    ))

    log.info({ task_id: taskId, steps_executed: stepResults.length }, '[ExecuteCommand] Tâche complétée (arrière-plan)')
  } catch (err) {
    await _markTaskError(db, taskId, orgId, err.message || 'Erreur inconnue')
    throw err
  } finally {
    db.release()
  }
}
