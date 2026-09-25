/**
 * server.js — Point d'entrée du process.
 *
 * Construit l'app via buildApp() (app.js — plugins + toutes les routes,
 * y compris /v1/session et /v1/actions/execute) et démarre l'écoute HTTP.
 * Séparé de app.js pour que les tests d'intégration puissent importer
 * buildApp() et utiliser fastify.inject() sans ouvrir de port réseau.
 */
import { buildApp } from './app.js'

const fastify = await buildApp()

fastify.listen({ port: 8000, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
