import Fastify from 'fastify'
import fastifyPostgres from '@fastify/postgres'

const fastify = Fastify({ logger: true })

// Activer CORS pour permettre les requêtes depuis le prototype HTML
fastify.register(require('@fastify/cors'), {
  origin: '*' // En production, remplacez par l'URL exacte du frontend
});

// Route pour recevoir la configuration client
fastify.post('/api/client/config', async (request, reply) => {
  const clientConfig = request.body;
  
  // Valider les données (exemple basique)
  if (!clientConfig.identite || !clientConfig.identite.company_name) {
    return reply.code(400).send({
      error: 'Le nom de l\'entreprise est obligatoire'
    });
  }
  
  // Simuler la sauvegarde en base de données
  console.log('Configuration client reçue:');
  console.log(JSON.stringify(clientConfig, null, 2));
  
  // Simuler un ID généré
  const configId = Math.floor(Math.random() * 10000);
  
  // Simuler un délai de traitement
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Répondre au client
  return reply.code(201).send({
    success: true,
    message: 'Configuration enregistrée avec succès',
    id: configId,
    timestamp: new Date().toISOString(),
    config: clientConfig
  });
});

// Connexion à PostgreSQL — DATABASE_URL vient du docker-compose.yml
await fastify.register(fastifyPostgres, {
  connectionString: process.env.DATABASE_URL
})

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', service: 'pactelys-api' }
})

// Route de vérification : fait un vrai aller-retour avec la base
fastify.get('/v1/db-check', async (request, reply) => {
  try {
    const client = await fastify.pg.connect()
    try {
      const { rows } = await client.query('SELECT NOW() as server_time, current_database() as db_name')
      return {
        status: 'ok',
        db_connected: true,
        server_time: rows[0].server_time,
        database: rows[0].db_name
      }
    } finally {
      client.release()
    }
  } catch (err) {
    request.log.error(err)
    reply.code(500)
    return { status: 'error', db_connected: false, message: err.message }
  }
})

fastify.listen({ port: 8000, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})