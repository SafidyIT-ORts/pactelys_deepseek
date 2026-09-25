/**
 * routes/session.js — Route GET /v1/session
 *
 * Route protégée par le middleware `verifyJwt`. Elle récupère les
 * informations de l'organisation authentifiée depuis PostgreSQL et
 * prépare le contexte RLS pour les futures requêtes.
 *
 * SÉCURITÉ :
 *   - Accessible uniquement avec un JWT RS256 valide.
 *   - SET LOCAL app.current_org_id prépare le Row Level Security PostgreSQL.
 *   - Aucun secret, clé, ou token brut n'est retourné ou journalisé.
 *   - La réponse est validée avec Zod avant envoi.
 *
 * USAGE (dans server.js) :
 *   import { sessionRoutes } from './routes/session.js'
 *   await fastify.register(sessionRoutes)
 */

import { z } from 'zod'
import { verifyJwt } from '../middleware/verifyJwt.js'

// ============================================================
// SCHÉMAS ZOD — Validation de la réponse (contrat d'API strict)
// ============================================================

/** Schéma d'une organisation retournée par la session */
const OrganizationSchema = z.object({
  id:                     z.string().uuid(),
  name:                   z.string(),
  status:                 z.enum(['active', 'suspended', 'trial']),
  membership_level:       z.string().default('starter'),
  organization_reference: z.string().nullable(),
  created_at:             z.string(), // ISO 8601
})

/** Schéma de la réponse complète de /v1/session */
const SessionResponseSchema = z.object({
  success:          z.literal(true),
  user: z.object({
    sub:              z.string(),
    role:             z.string(),
    membership_level: z.string(),
  }),
  organization: OrganizationSchema,
})

/** Schéma d'erreur */
const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error:   z.string(),
})

// ============================================================
// PLUGIN FASTIFY — Enregistrement de la route
// ============================================================

/**
 * Enregistre la route GET /v1/session sur l'instance Fastify.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function sessionRoutes(fastify) {

  fastify.get('/v1/session', {
    // Protection JWT — injecte request.jwtPayload si valide
    preHandler: verifyJwt,

    // Schéma de réponse Fastify (sérialisation rapide + doc auto)
    schema: {
      tags:        ['auth'],
      summary:     'Récupère la session et les informations de l\'organisation authentifiée',
      description: 'Endpoint protégé par JWT RS256. Retourne l\'organisation liée au token WP.',
      headers: {
        type: 'object',
        required: ['authorization'],
        properties: {
          authorization: {
            type:        'string',
            description: 'Bearer <jwt_rs256>',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success:      { type: 'boolean' },
            user:         { type: 'object' },
            organization: { type: 'object' },
          },
        },
        401: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error:   { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error:   { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    // À ce stade, verifyJwt a déjà validé le token et injecté request.jwtPayload
    const { sub, organization_reference, role, membership_level } = request.jwtPayload

    if (!organization_reference) {
      request.log.warn({ sub }, '[Session] JWT valide mais organization_reference vide')
      return reply.code(404).send({
        success: false,
        error:   'Aucune organisation associée à ce compte. Contactez l\'administrateur Pactelys.',
      })
    }

    const client = await fastify.pg.connect()
    try {
      // ---- PRÉPARATION DU CONTEXTE RLS ----
      // SET LOCAL est limité à la transaction courante (plus sûr que SET SESSION).
      // Cela permet d'activer les politiques RLS PostgreSQL sur n'importe quelle
      // table sans modifier le code métier des autres requêtes.
      // Voir: backend/migrations/001_initial_schema.sql pour les instructions d'activation.
      //
      // NB : `SET LOCAL x = $1` n'est pas valide (PostgreSQL n'accepte pas de
      // paramètre lié dans une commande SET — "syntax error at or near $1").
      // set_config(setting, value, is_local) accepte des paramètres normaux ;
      // is_local=true reproduit le comportement de SET LOCAL.
      await client.query(
        `SELECT set_config('app.current_org_id', $1, true)`,
        [organization_reference]
      )

      // ---- REQUÊTE ORGANISATION ----
      // Pas de SELECT * — on sélectionne uniquement les colonnes nécessaires
      // pour éviter de fuiter des données sensibles (ex: wordpress_user_id interne).
      const result = await client.query(
        `SELECT
           id,
           name,
           status,
           COALESCE(membership_level, 'starter') AS membership_level,
           organization_reference,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM organizations
         WHERE organization_reference = $1
           AND status != 'suspended'
         LIMIT 1`,
        [organization_reference]
      )

      if (result.rowCount === 0) {
        request.log.warn({ sub, orgRef: organization_reference },
          '[Session] Organisation introuvable ou suspendue pour cette reference')
        return reply.code(404).send({
          success: false,
          error:   'Organisation introuvable ou suspendue.',
        })
      }

      const org = result.rows[0]

      // ---- VALIDATION ZOD de la réponse ----
      // Garantit que la réponse respecte le contrat d'API
      // même si le schéma BDD évolue.
      const parsed = SessionResponseSchema.safeParse({
        success:      true,
        user: {
          sub,
          role,
          membership_level,
        },
        organization: {
          id:                     org.id,
          name:                   org.name,
          status:                 org.status,
          membership_level:       org.membership_level,
          organization_reference: org.organization_reference,
          created_at:             org.created_at,
        },
      })

      if (!parsed.success) {
        // Problème de cohérence interne — ne pas exposer les détails Zod en prod
        request.log.error({ zodError: parsed.error.issues },
          '[Session] Erreur de validation Zod sur la réponse interne')
        return reply.code(500).send({
          success: false,
          error:   'Erreur interne de sérialisation.',
        })
      }

      request.log.info({
        sub,
        orgId:  org.id,
        orgRef: organization_reference,
        status: org.status,
      }, '[Session] Session récupérée avec succès')

      return reply.code(200).send(parsed.data)

    } catch (err) {
      // Ne jamais exposer les détails SQL en production
      request.log.error({ message: err.message, code: err.code },
        '[Session] Erreur PostgreSQL lors de la récupération de la session')
      return reply.code(500).send({
        success: false,
        error:   'Erreur interne du serveur.',
        detail:  process.env.NODE_ENV === 'development' ? err.message : undefined,
      })
    } finally {
      // Libérer la connexion dans TOUS les cas (succès ou erreur)
      client.release()
    }
  })
}
