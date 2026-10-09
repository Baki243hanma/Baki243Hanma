/**
 * Point d'entrée du serveur ShopFlow RDC (« npm start »).
 *
 * Variables d'environnement :
 *  - PORT (fourni par Render, défaut 3000), HOST (défaut 0.0.0.0)
 *  - DATABASE_URL : chaîne de connexion Neon (secrète, serveur uniquement).
 *      Sans elle : /api/sync/* répond 503 et l'application reste utilisable en mode local.
 *  - NEON_AUTH_URL : URL publique de Neon Auth (non secrète). Sans elle : pas d'authentification.
 *  - MIGRATE_ON_START (défaut « true ») : applique db/migrations au démarrage si DATABASE_URL est définie.
 */
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createPgDatabase, migrate } from './db.js';
import { AuthConfigError, authOrigin, createTokenVerifier } from './auth.js';

export function readConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    databaseUrl: (env.DATABASE_URL || '').trim(),
    authUrl: (env.NEON_AUTH_URL || '').trim().replace(/\/+$/, ''),
    migrateOnStart: (env.MIGRATE_ON_START || 'true').toLowerCase() !== 'false',
  };
}

async function main() {
  const config = readConfig();

  let db = null;
  if (config.databaseUrl) {
    db = createPgDatabase(config.databaseUrl);
    if (config.migrateOnStart) {
      const applied = await migrate(db);
      console.log(`[db] migrations appliquées : ${applied.length ? applied.join(', ') : 'aucune (à jour)'}`);
    }
  } else {
    console.log('[db] DATABASE_URL absente : synchronisation désactivée (mode local).');
  }

  let verifyToken = null;
  let authUrl = '';
  if (config.authUrl) {
    try {
      authOrigin(config.authUrl);
      authUrl = config.authUrl;
      verifyToken = createTokenVerifier({ authUrl });
    } catch (error) {
      if (!(error instanceof AuthConfigError)) throw error;
      console.error(`[auth] ${error.message} Authentification désactivée.`);
    }
  } else {
    console.log('[auth] NEON_AUTH_URL absente : authentification désactivée (mode local).');
  }

  const app = createApp({ db, verifyToken, authUrl });
  app.listen(config.port, config.host, () => {
    console.log(`ShopFlow RDC en écoute sur http://${config.host}:${config.port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('[démarrage] échec :', error.message);
    process.exit(1);
  });
}
