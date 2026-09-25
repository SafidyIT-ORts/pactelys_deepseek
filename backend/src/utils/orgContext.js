/**
 * utils/orgContext.js — Positionne app.current_org_id pour le RLS PostgreSQL
 *
 * SET LOCAL n'a d'effet que pour la transaction SQL en cours. Envoyé seul,
 * hors BEGIN/COMMIT explicite, il constitue sa propre transaction implicite
 * et n'a donc AUCUN effet sur les requêtes suivantes envoyées sur la même
 * connexion. withOrgScope() englobe SET LOCAL et les requêtes protégées
 * dans une même transaction explicite, pour que les policies RLS
 * (voir migrations/003_enable_rls.sql) voient la bonne valeur.
 *
 * IMPORTANT : `SET LOCAL x = $1` n'est PAS valide — PostgreSQL n'accepte pas
 * de paramètre lié dans une commande SET (erreur "syntax error at or near
 * $1"). On utilise donc la fonction set_config(setting, value, is_local),
 * qui elle accepte des paramètres normaux, avec is_local=true en 3ᵉ argument
 * pour reproduire exactement le comportement de SET LOCAL (portée = la
 * transaction en cours).
 */

/**
 * @param {import('pg').PoolClient} client - Connexion déjà acquise via fastify.pg.connect()
 * @param {string} orgId - UUID de l'organisation à positionner dans app.current_org_id
 * @param {() => Promise<any>} fn - Requêtes à exécuter dans ce contexte
 * @returns {Promise<any>}
 */
export async function withOrgScope(client, orgId, fn) {
  await client.query('BEGIN')
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId])
    const result = await fn()
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}
