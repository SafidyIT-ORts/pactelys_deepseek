import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyPostgres from '@fastify/postgres'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import claudeBrain from './services/claudeBrain.js'
import { sessionRoutes } from './routes/session.js'
import { executeRoutes } from './routes/execute.js'
import { withOrgScope } from './utils/orgContext.js'

/**
 * Construit et retourne l'instance Fastify entièrement configurée
 * (plugins + routes), SANS appeler fastify.listen().
 *
 * Extrait de server.js pour permettre aux tests d'intégration d'importer
 * l'application et de l'interroger via fastify.inject(), sans ouvrir de
 * vrai port réseau ni dépendre de process.env au moment de l'import.
 *
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp() {
  const fastify = Fastify({ logger: true })

  await fastify.register(cors, {
    origin: ['http://localhost', 'https://prototype.pactelys.fr', 'https://app.pactelys.fr', 'null', 'https://baobabs.org']
  })

  await fastify.register(fastifyPostgres, {
    connectionString: process.env.DATABASE_URL
  })

  // ============================================================
  // Clé API partagée — verrou minimal pour toute exposition publique
  // de cette instance (ex: page HTML sur baobabs.org). Sans clé
  // configurée (PUBLIC_API_KEY absent, cas du dev local), aucune
  // vérification n'est faite — ne pas déployer publiquement sans
  // avoir défini PUBLIC_API_KEY dans l'environnement.
  // /health reste ouvert (supervision) ; OPTIONS reste ouvert (le
  // preflight CORS du navigateur n'envoie jamais le header custom).
  // ============================================================
  const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY
  if (PUBLIC_API_KEY) {
    fastify.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS' || request.url === '/health') return
      const provided = request.headers['x-api-key']
      if (provided !== PUBLIC_API_KEY) {
        return reply.code(401).send({ success: false, error: 'Clé API manquante ou invalide (header X-API-Key).' })
      }
    })
  } else {
    fastify.log.warn('[Sécurité] PUBLIC_API_KEY non défini — toutes les routes sont ouvertes sans authentification. Ne pas exposer publiquement dans cet état.')
  }

  // ============================================================
  // Route d'authentification — Pont WordPress ↔ Fastify
  // ============================================================
  await fastify.register(sessionRoutes)

  // ============================================================
  // Routes d'exécution IA — Le "cerveau" qui remplace n8n
  // POST /v1/actions/execute  → exécute une tâche complète
  // GET  /v1/actions/status/:id → polling léger du statut
  // ============================================================
  await fastify.register(executeRoutes)

  // ============================================================
  // Génère les 3 fichiers markdown à partir de la config stockée en base
  // ============================================================
  function generateMarkdownFiles(cfg) {
    const primaryTitles = cfg.icp_primary_titles || []
    const secondaryTitles = cfg.icp_secondary_titles || []
    const buyingSignals = cfg.icp_buying_signals || []
    const exclusionCriteria = cfg.icp_exclusion_criteria || []
    const behaviorRules = cfg.behavior_rules || []
    const funnel = cfg.conversion_funnel || []
    const keyUrls = cfg.key_urls || {}
    const toneTraits = cfg.tone_traits || []
    const keyMessages = cfg.key_messages || []
    const validatedPhrases = cfg.validated_phrases || []

    const CLAUDE_MD = `# ${cfg.company_name} - Configuration Claude Code GTM

Entreprise : ${cfg.company_name} | Secteur : ${cfg.sector || '[à compléter]'} | Taille : ${cfg.company_size || '[à compléter]'}
CA cible : ${cfg.target_revenue || '[à compléter]'} | Marché : ${cfg.market || '[à compléter]'}

## Promesse centrale
${cfg.core_promise || '[à compléter]'}

## ICP (Ideal Customer Profile)
Secteur cible : ${cfg.icp_target_sector || '[à compléter]'}
Taille entreprise : ${cfg.icp_company_size || '[à compléter]'}
Titre du contact : ${primaryTitles.join(', ') || '[à compléter]'}
Zone géographique : ${cfg.icp_geography || '[à compléter]'}
Signaux d'achat : ${buyingSignals.join('; ') || '[à compléter]'}

## Proposition de valeur
Problème résolu : ${cfg.value_prop_problem || '[à compléter]'}
Bénéfice principal : ${cfg.value_prop_benefit || '[à compléter]'}
Différenciateur clé : ${cfg.value_prop_differentiator || '[à compléter]'}

## Règles de comportement
- Toujours utiliser le ${cfg.tone_of_voice || 'vouvoiement'} dans les communications
${behaviorRules.map(r => `- ${r}`).join('\n') || '- [à compléter]'}

## Règle de traçabilité
Tout chiffre utilisé dans un contenu doit être marqué [Source vérifiée] ou [Exemple illustratif], jamais présenté comme un fait sans étiquette.

## Règle de mesure
Le parcours à suivre est : ${funnel.length ? funnel.join(' → ') : '[tunnel à compléter]'}.

## Règle d'autonomie du contenu
Chaque article, post ou email doit être compréhensible indépendamment des autres, sans supposer que le lecteur a vu un contenu précédent.

## Règle d'architecture de contenu
Les intentions de recherche les plus commerciales doivent devenir des pages pérennes dédiées, pas de simples articles de blog.

## Contexte obligatoire avant les commandes des plugins GTM
- Avant d'exécuter toute commande GTM, toujours lire automatiquement Brand.md et S01.md.

## Sources de données pour les statistiques
- D'abord, consulter ${cfg.website_url || '[URL à compléter]'} pour les chiffres propres à l'entreprise.
- Si aucune source fiable, reformuler en qualitatif — ne jamais inventer un chiffre.
${keyUrls.primary_cta ? `\n## CTA de conversion principal\n${keyUrls.primary_cta}` : ''}`

    const BRAND_MD = `# Brand.md

## Nom et description
${cfg.company_name} - ${cfg.value_prop_benefit || '[description à compléter]'}

## Positionnement
Pour : ${cfg.icp_target_sector || '[à compléter]'}
Qui : ${buyingSignals.join(', ') || '[à compléter]'}
Notre solution est : ${cfg.value_prop_benefit || '[à compléter]'}
Contrairement à : ${cfg.positioning_contrast || '[à compléter]'}
Notre avantage : ${cfg.value_prop_differentiator || '[à compléter]'}

## Ton de communication
${toneTraits.map(t => `- ${t}`).join('\n') || '- [à compléter]'}

## Messages clés (à utiliser dans tout le contenu)
${keyMessages.map((m, i) => `${i + 1}. ${m}`).join('\n') || '1. [à compléter]'}

## Exemples de formulations validées
${validatedPhrases.map(p => `- ${p}`).join('\n') || '- [à compléter]'}`

    const S01_MD = `# S01.md - Ideal Customer Profile

## Entreprise cible
Secteur : ${cfg.icp_target_sector || '[à compléter]'}
CA annuel : ${cfg.target_revenue || '[à compléter]'}
Effectif : ${cfg.icp_company_size || '[à compléter]'}
Technologie : ${cfg.icp_technology || '[à compléter]'}
Stade : ${cfg.icp_stage || '[à compléter]'}

## Contact cible
Titres prioritaires : ${primaryTitles.join(', ') || '[à compléter]'}
Titres secondaires : ${secondaryTitles.join(', ') || '[à compléter]'}
Ancienneté minimum : ${cfg.icp_seniority_minimum || '[à compléter]'}

## Signaux d'achat (priorité haute)
${buyingSignals.map(s => `- ${s}`).join('\n') || '- [à compléter]'}

## Critères d'exclusion
${exclusionCriteria.map(c => `- ${c}`).join('\n') || '- [à compléter]'}`

    return { CLAUDE_MD, BRAND_MD, S01_MD }
  }

  // ============================================================
  // Routes
  // ============================================================

  fastify.get('/health', async () => {
    return { status: 'ok', service: 'pactelys-api', timestamp: new Date().toISOString() }
  })

  // ============================================================
  // Catalogue plugins/commandes/paramètres — pour le sélecteur manuel
  // "catégorie > plugin > commande" de la console (alternative au texte
  // libre + routeur IA). Généré une fois par
  // backend/scripts/build_plugin_catalog.js, servi tel quel ici — mis en
  // cache mémoire process, pas la peine de relire le fichier à chaque
  // requête (le catalogue ne change qu'en régénérant le script).
  // ============================================================
  let _pluginCatalogCache = null
  fastify.get('/v1/plugin-catalog', async (request, reply) => {
    try {
      if (!_pluginCatalogCache) {
        const raw = await fs.readFile(path.join(import.meta.dirname, 'data', 'plugin-catalog.json'), 'utf-8')
        _pluginCatalogCache = JSON.parse(raw)
      }
      return reply.send({ success: true, catalog: _pluginCatalogCache })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: 'Catalogue plugins introuvable ou invalide — as-tu lancé build_plugin_catalog.js ?' })
    }
  })
  fastify.get('/api/client/config/:id', async (request, reply) => {
    const { id } = request.params
    const client = await fastify.pg.connect()
    try {
      const result = await withOrgScope(client, id, () =>
        client.query(`SELECT * FROM client_config WHERE org_id = $1`, [id])
      )
      if (result.rowCount === 0) {
        return reply.code(404).send({ success: false, error: 'Introuvable' })
      }
      // Les actions activées vivent dans une table séparée (client_enabled_actions),
      // pas dans client_config — sans ça, un formulaire qui recharge une fiche
      // existante ne peut jamais retrouver les cases cochées.
      const actionsResult = await withOrgScope(client, id, () =>
        client.query(`SELECT action_id FROM client_enabled_actions WHERE org_id = $1`, [id])
      )
      const config = { ...result.rows[0], actions_enabled: actionsResult.rows.map(r => r.action_id) }
      return reply.send({ success: true, config })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })



  fastify.post('/api/client/config', async (request, reply) => {
    const config = request.body

    if (!config.identite?.company_name) {
      return reply.code(400).send({ success: false, error: "Le nom de l'entreprise est obligatoire" })
    }

    // Généré côté application (et non via gen_random_uuid() en base) : la policy
    // RLS org_isolation s'applique aussi aux INSERT, il faut donc connaître
    // org_id AVANT le premier INSERT pour pouvoir positionner app.current_org_id.
    const orgId = randomUUID()

    const client = await fastify.pg.connect()
    try {
      await withOrgScope(client, orgId, async () => {
        await client.query(
          `INSERT INTO organizations (id, name) VALUES ($1, $2)`,
          [orgId, config.identite.company_name]
        )

        await client.query(
      `INSERT INTO client_config (
        org_id, company_name, sector, company_size, target_revenue, market,
        website_url, content_language, core_promise,
        icp_target_sector, icp_company_size, icp_primary_titles,
        icp_secondary_titles, icp_geography, icp_buying_signals, icp_exclusion_criteria,
        icp_technology, icp_stage, icp_seniority_minimum,
        value_prop_problem, value_prop_benefit, value_prop_differentiator,
        positioning_contrast, tone_traits, key_messages, validated_phrases,
        tone_of_voice, behavior_rules, conversion_funnel, key_urls
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
      [
        orgId, config.identite?.company_name, config.identite?.sector, config.identite?.company_size,
        config.identite?.target_revenue, config.identite?.market, config.identite?.website_url,
        config.identite?.content_language || 'fr-FR', config.promesse?.core_promise,
        config.icp?.target_sector, config.icp?.company_size,
        JSON.stringify(config.icp?.primary_titles || []), JSON.stringify(config.icp?.secondary_titles || []),
        config.icp?.geography, JSON.stringify(config.icp?.buying_signals || []), JSON.stringify(config.icp?.exclusion_criteria || []),
        config.icp?.technology, config.icp?.stage, config.icp?.seniority_minimum,
        config.valeur?.problem, config.valeur?.benefit, config.valeur?.differentiator,
        config.positionnement?.contrast,
        JSON.stringify(config.brand?.tone_traits || []), JSON.stringify(config.brand?.key_messages || []), JSON.stringify(config.brand?.validated_phrases || []),
        config.regles?.tone_of_voice || 'vouvoiement', JSON.stringify(config.regles?.behavior_rules || []),
        JSON.stringify(config.regles?.conversion_funnel || []), JSON.stringify({ primary_cta: config.regles?.primary_cta_url || null })
      ]
    )

        for (const actionId of (config.actions_enabled || [])) {
          await client.query(
            `INSERT INTO client_enabled_actions (org_id, action_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [orgId, actionId]
          )
        }
      })

      return reply.code(201).send({
        success: true,
        message: 'Configuration enregistrée en base',
        org_id: orgId,
        actions_enabled: config.actions_enabled || []
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  // ============================================================
  // Gestion des comptes (organizations) — liste + suppression
  // ============================================================
  fastify.get('/v1/organizations', async (request, reply) => {
    const client = await fastify.pg.connect()
    try {
      // md_files_count (0-3) : nombre de fichiers .md réellement remplis pour
      // ce compte — sert la console web à afficher l'état de chaque compte
      // sans avoir à ouvrir chacun un par un (gestion de comptes plus lisible
      // quand il y en a beaucoup, notamment les comptes de test).
      const result = await client.query(
        `SELECT o.id, o.name, o.status, o.created_at,
                (CASE WHEN NULLIF(TRIM(cc.claude_md_raw), '') IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN NULLIF(TRIM(cc.brand_md_raw), '') IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN NULLIF(TRIM(cc.s01_md_raw), '') IS NOT NULL THEN 1 ELSE 0 END)::int AS md_files_count
         FROM organizations o
         LEFT JOIN client_config cc ON cc.org_id = o.id
         ORDER BY o.created_at DESC`
      )
      return reply.send({ success: true, organizations: result.rows })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.delete('/v1/organizations/:id', async (request, reply) => {
    const { id } = request.params
    const client = await fastify.pg.connect()
    try {
      // ON DELETE CASCADE sur client_config/tasks/client_enabled_actions/
      // ai_connections (voir migrations/001_initial_schema.sql) : supprimer
      // la ligne organizations suffit à tout nettoyer côté base.
      const result = await client.query(`DELETE FROM organizations WHERE id = $1`, [id])
      if (result.rowCount === 0) {
        return reply.code(404).send({ success: false, error: 'Organisation introuvable.' })
      }

      // Les fichiers .md sur disque ne sont pas en base, à nettoyer à part.
      // Non bloquant : un dossier déjà absent ne doit pas faire échouer la suppression.
      try {
        await fs.rm(path.join('/app/clients', id), { recursive: true, force: true })
      } catch (fsErr) {
        request.log.warn({ org_id: id, error: fsErr.message }, '[DeleteOrg] Nettoyage disque échoué')
      }

      return reply.send({ success: true, org_id: id })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.get('/v1/organizations/:id/markdown-files', async (request, reply) => {
    const { id } = request.params

    const client = await fastify.pg.connect()
    try {
      const result = await withOrgScope(client, id, () =>
        client.query(`SELECT * FROM client_config WHERE org_id = $1`, [id])
      )
      if (result.rowCount === 0) {
        return reply.code(404).send({ success: false, error: 'Configuration introuvable pour cette organisation' })
      }

      const cfg = result.rows[0]

      // Priorité aux fichiers bruts importés (déjà complets et réels) —
      // on ne retombe sur la génération automatique que si un fichier
      // brut est absent ou vide pour ce client précis.
      const files = {
        CLAUDE_MD: (cfg.claude_md_raw && cfg.claude_md_raw.trim())
          ? cfg.claude_md_raw
          : generateMarkdownFiles(cfg).CLAUDE_MD,
        BRAND_MD: (cfg.brand_md_raw && cfg.brand_md_raw.trim())
          ? cfg.brand_md_raw
          : generateMarkdownFiles(cfg).BRAND_MD,
        S01_MD: (cfg.s01_md_raw && cfg.s01_md_raw.trim())
          ? cfg.s01_md_raw
          : generateMarkdownFiles(cfg).S01_MD,
      }

      const source = {
        CLAUDE_MD: (cfg.claude_md_raw && cfg.claude_md_raw.trim()) ? 'raw_import' : 'generated',
        BRAND_MD: (cfg.brand_md_raw && cfg.brand_md_raw.trim()) ? 'raw_import' : 'generated',
        S01_MD: (cfg.s01_md_raw && cfg.s01_md_raw.trim()) ? 'raw_import' : 'generated',
      }

      const orgDir = path.join('/app/clients', id)
      await fs.mkdir(orgDir, { recursive: true })
      await fs.writeFile(path.join(orgDir, 'CLAUDE.md'), files.CLAUDE_MD)
      await fs.writeFile(path.join(orgDir, 'Brand.md'), files.BRAND_MD)
      await fs.writeFile(path.join(orgDir, 'S01.md'), files.S01_MD)

      return reply.send({ success: true, files, source, written_to: orgDir })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.get('/v1/prompt-template/:action_id', async (request, reply) => {
    const { action_id } = request.params
    const client = await fastify.pg.connect()
    try {
      const result = await client.query(
        `SELECT step_order, model, tools_config, system_prompt_final
         FROM prompt_templates
         WHERE action_id = $1 AND is_active = true
         ORDER BY step_order ASC`,
        [action_id]
      )
      if (result.rowCount === 0) {
        return reply.code(404).send({ success: false, error: 'Action inconnue' })
      }
      return reply.send({ success: true, steps: result.rows })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.patch('/v1/tasks/:id', async (request, reply) => {
    const { id } = request.params
    const { status, result: taskResult, error_message } = request.body
    const client = await fastify.pg.connect()
    try {
      await client.query(
        `UPDATE tasks SET status = $1, result = $2, error_message = $3, updated_at = NOW()
         WHERE id = $4`,
        [status, taskResult || null, error_message || null, id]
      )
      return reply.send({ success: true })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.post('/v1/tasks', async (request, reply) => {
    const { org_id, action_id, params } = request.body
    if (!org_id || !action_id) {
      return reply.code(400).send({ success: false, error: 'org_id et action_id sont obligatoires' })
    }
    const client = await fastify.pg.connect()
    try {
      const result = await withOrgScope(client, org_id, async () => {
        const check = await client.query(
          `SELECT 1 FROM client_enabled_actions WHERE org_id = $1 AND action_id = $2`,
          [org_id, action_id]
        )
        if (check.rowCount === 0) {
          return { forbidden: true }
        }
        const inserted = await client.query(
          `INSERT INTO tasks (org_id, action_id, params, status) VALUES ($1, $2, $3, 'queued') RETURNING id, status, created_at`,
          [org_id, action_id, JSON.stringify(params || {})]
        )
        return { forbidden: false, row: inserted.rows[0] }
      })
      if (result.forbidden) {
        return reply.code(403).send({ success: false, error: `Action "${action_id}" non activée pour cette organisation` })
      }
      return reply.code(201).send({ success: true, task_id: result.row.id, status: result.row.status })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.get('/v1/tasks/:id', async (request, reply) => {
    const { id } = request.params
    const client = await fastify.pg.connect()
    try {
      const result = await client.query(`SELECT * FROM tasks WHERE id = $1`, [id])
      if (result.rowCount === 0) {
        return reply.code(404).send({ success: false, error: 'Tâche introuvable' })
      }
      return reply.send({ success: true, task: result.rows[0] })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.patch('/v1/organizations/:id/raw-config', async (request, reply) => {
    const { id } = request.params
    const { claude_md_raw, brand_md_raw, s01_md_raw } = request.body

    const client = await fastify.pg.connect()
    try {
      const result = await withOrgScope(client, id, () =>
        client.query(
          `UPDATE client_config
           SET claude_md_raw = $1, brand_md_raw = $2, s01_md_raw = $3, updated_at = NOW()
           WHERE org_id = $4`,
          [claude_md_raw, brand_md_raw, s01_md_raw, id]
        )
      )
      if (result.rowCount === 0) {
        return reply.code(404).send({ success: false, error: "Aucune ligne client_config pour cette organisation — crée-la d'abord via le formulaire complet." })
      }
      return reply.send({ success: true, org_id: id })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  fastify.patch('/api/client/config/:id/full', async (request, reply) => {
    const { id } = request.params
    const config = request.body

    const client = await fastify.pg.connect()
    try {
      await withOrgScope(client, id, async () => {
        await client.query(
          `UPDATE client_config SET
            company_name=$1, sector=$2, company_size=$3, target_revenue=$4, market=$5,
            website_url=$6, content_language=$7, core_promise=$8,
            icp_target_sector=$9, icp_company_size=$10, icp_primary_titles=$11,
            icp_secondary_titles=$12, icp_geography=$13, icp_buying_signals=$14, icp_exclusion_criteria=$15,
            icp_technology=$16, icp_stage=$17, icp_seniority_minimum=$18,
            value_prop_problem=$19, value_prop_benefit=$20, value_prop_differentiator=$21,
            positioning_contrast=$22, tone_traits=$23, key_messages=$24, validated_phrases=$25,
            tone_of_voice=$26, behavior_rules=$27, conversion_funnel=$28, key_urls=$29,
            updated_at=NOW()
          WHERE org_id=$30`,
          [
            config.identite?.company_name, config.identite?.sector, config.identite?.company_size,
            config.identite?.target_revenue, config.identite?.market, config.identite?.website_url,
            config.identite?.content_language || 'fr-FR', config.promesse?.core_promise,
            config.icp?.target_sector, config.icp?.company_size,
            JSON.stringify(config.icp?.primary_titles || []), JSON.stringify(config.icp?.secondary_titles || []),
            config.icp?.geography, JSON.stringify(config.icp?.buying_signals || []), JSON.stringify(config.icp?.exclusion_criteria || []),
            config.icp?.technology, config.icp?.stage, config.icp?.seniority_minimum,
            config.valeur?.problem, config.valeur?.benefit, config.valeur?.differentiator,
            config.positionnement?.contrast,
            JSON.stringify(config.brand?.tone_traits || []), JSON.stringify(config.brand?.key_messages || []), JSON.stringify(config.brand?.validated_phrases || []),
            config.regles?.tone_of_voice || 'vouvoiement', JSON.stringify(config.regles?.behavior_rules || []),
            JSON.stringify(config.regles?.conversion_funnel || []), JSON.stringify({ primary_cta: config.regles?.primary_cta_url || null }),
            id
          ]
        )

        // Nom de l'organisation aussi à jour si changé
        if (config.identite?.company_name) {
          await client.query(`UPDATE organizations SET name = $1 WHERE id = $2`, [config.identite.company_name, id])
        }

        // Synchronise les actions activées si le formulaire en envoie un tableau
        // (même sémantique que le POST de création) — remplace intégralement
        // l'ensemble existant, y compris pour le vider si actions_enabled: [].
        if (Array.isArray(config.actions_enabled)) {
          await client.query(`DELETE FROM client_enabled_actions WHERE org_id = $1`, [id])
          for (const actionId of config.actions_enabled) {
            await client.query(
              `INSERT INTO client_enabled_actions (org_id, action_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [id, actionId]
            )
          }
        }
      })

      return reply.send({ success: true, org_id: id })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      client.release()
    }
  })

  // ============================================================
  // Route IA - Génération de contenu avec Claude
  // ============================================================
  fastify.post('/v1/ai/generate', async (request, reply) => {
    const { org_id, action_type, user_input, model, provider } = request.body

    // Validation des paramètres obligatoires
    if (!org_id || !action_type || !user_input) {
      return reply.code(400).send({
        success: false,
        error: 'Paramètres manquants: org_id, action_type et user_input sont obligatoires'
      })
    }

    try {
      const result = await claudeBrain.generateContent({
        orgId: org_id,
        actionType: action_type,
        userInput: user_input,
        model: model || 'claude-3-5-sonnet-20241022',
        provider: provider === 'claude' ? 'claude' : 'deepseek',
      })

      return reply.code(200).send(result)
    } catch (error) {
      request.log.error(error)
      return reply.code(500).send({
        success: false,
        error: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    }
  })

  return fastify
}
