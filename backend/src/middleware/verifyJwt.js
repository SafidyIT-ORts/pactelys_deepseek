/**
 * middleware/verifyJwt.js — Validation JWT RS256 pour l'API Pactelys
 *
 * Ce middleware vérifie le token JWT RS256 émis par le plugin WordPress
 * `pactelys-bridge`. Il est conçu pour être utilisé comme `preHandler`
 * sur les routes Fastify protégées.
 *
 * SÉCURITÉ :
 *   - La clé PUBLIQUE uniquement est présente côté API (jamais la privée).
 *   - Le JWT brut n'est JAMAIS journalisé (Pino ou autre).
 *   - L'expiration est vérifiée avec une tolérance zéro (clockTolerance: 0).
 *   - Les erreurs retournent un message générique en production.
 *
 * USAGE :
 *   import { verifyJwt } from './middleware/verifyJwt.js'
 *   fastify.get('/v1/session', { preHandler: verifyJwt }, handler)
 *
 * VARIABLES D'ENVIRONNEMENT REQUISES :
 *   JWT_PUBLIC_KEY — Clé publique RS256 en format PEM ou SPKI, ex:
 *                    "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
 */

import { jwtVerify, importSPKI } from 'jose'

// ============================================================
// CONSTANTES DE VALIDATION (doivent correspondre au plugin WP)
// ============================================================
const EXPECTED_ISSUER   = 'https://pactelys.fr'
const EXPECTED_AUDIENCE = 'pactelys-ai-api'
const MAX_TOKEN_AGE     = '300s'

// ============================================================
// IMPORT DE LA CLÉ PUBLIQUE
// (fait une seule fois au démarrage du processus pour la performance)
// ============================================================
let _cachedPublicKey = null

/**
 * Charge et met en cache la clé publique RS256 depuis la variable d'env.
 * La clé n'est jamais exposée en dehors de ce module.
 *
 * @returns {Promise<CryptoKey>}
 * @throws {Error} Si JWT_PUBLIC_KEY n'est pas définie ou est invalide.
 */
async function getPublicKey() {
  if (_cachedPublicKey) return _cachedPublicKey

  const rawKey = process.env.JWT_PUBLIC_KEY
  if (!rawKey || rawKey.trim() === '') {
    throw new Error(
      '[Pactelys Auth] JWT_PUBLIC_KEY est absent des variables d\'environnement. ' +
      'Ajoutez la clé publique RS256 dans votre fichier .env ou dans la configuration Docker.'
    )
  }

  // Normaliser les \n littéraux (fréquents dans les variables d'env sur une seule ligne)
  const normalizedKey = rawKey.replace(/\\n/g, '\n')

  // importSPKI gère le format "-----BEGIN PUBLIC KEY-----" (SPKI/X.509)
  _cachedPublicKey = await importSPKI(normalizedKey, 'RS256')
  return _cachedPublicKey
}

// ============================================================
// MIDDLEWARE FASTIFY — preHandler
// ============================================================

/**
 * Vérifie le JWT RS256 dans le header `Authorization: Bearer <token>`.
 *
 * En cas de succès, injecte `request.jwtPayload` avec les champs safe :
 *   {
 *     sub: string,                   // WP user ID
 *     organization_reference: string, // référence org dans l'API Fastify
 *     role: string,                  // admin | manager | member
 *     membership_level: string,      // starter | growth | scale | enterprise
 *   }
 *
 * En cas d'échec, retourne HTTP 401 avec un message générique.
 * Les détails techniques sont journalisés SANS le token brut.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function verifyJwt(request, reply) {
  const authHeader = request.headers['authorization']

  // --- 1. Vérifier la présence du header ---
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({
      success: false,
      error: 'Authorization header manquant ou invalide. Format attendu: Bearer <token>'
    })
  }

  // Extraire le token SANS le journaliser
  const token = authHeader.slice(7)

  try {
    const publicKey = await getPublicKey()

    // --- 2. Vérification complète via `jose` ---
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms:     ['RS256'],          // RS256 uniquement — refuser HS256 et "none"
      issuer:         EXPECTED_ISSUER,    // iss === "https://pactelys.fr"
      audience:       EXPECTED_AUDIENCE,  // aud === "pactelys-ai-api"
      maxTokenAge:    MAX_TOKEN_AGE,      // exp - iat <= 300s
      clockTolerance: 0,                  // zéro tolérance sur le drift d'horloge
    })

    // --- 3. Valider les champs métier du payload ---
    if (!payload.sub || !payload.organization_reference) {
      request.log.warn({ sub: payload.sub, hasOrgRef: !!payload.organization_reference },
        '[Pactelys Auth] JWT valide mais payload incomplet — champs manquants')
      return reply.code(401).send({
        success: false,
        error: 'Token invalide : payload incomplet.'
      })
    }

    // --- 4. Injecter uniquement les champs nécessaires (pas le payload complet) ---
    // Ne jamais exposer les champs techniques JWT (iat, exp, iss, aud) aux routes
    request.jwtPayload = {
      sub:                    payload.sub,
      organization_reference: payload.organization_reference,
      role:                   payload.role   || 'member',
      membership_level:       payload.membership_level || 'starter',
    }

    // Log de contexte (SANS token, SANS clé — uniquement les méta-données utiles)
    request.log.info({
      sub:    payload.sub,
      orgRef: payload.organization_reference,
      role:   payload.role,
    }, '[Pactelys Auth] JWT validé avec succès')

  } catch (err) {
    // Journaliser la RAISON (type d'erreur) mais JAMAIS le token lui-même
    const errorType = err.code || err.constructor?.name || 'JWTError'
    request.log.warn({ errorType, message: err.message },
      '[Pactelys Auth] Échec de validation du JWT')

    // Message générique pour le client — ne pas leaker les détails techniques
    const isDev = process.env.NODE_ENV === 'development'
    return reply.code(401).send({
      success: false,
      error:   'Token invalide ou expiré.',
      // En dev uniquement : aide au débogage sans exposer le token
      detail:  isDev ? `${errorType}: ${err.message}` : undefined,
    })
  }
}
