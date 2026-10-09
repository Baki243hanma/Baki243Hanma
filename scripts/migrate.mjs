/**
 * Applique les migrations SQL (db/migrations) à la base Neon indiquée par DATABASE_URL.
 * Usage : DATABASE_URL="postgresql://…" npm run db:migrate
 * (Le serveur applique aussi les migrations au démarrage ; ce script permet de le faire à la main.)
 */
import { createPgDatabase, migrate } from '../server/db.js';

const url = (process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error('DATABASE_URL est requise (chaîne de connexion Neon, sans la publier).');
  process.exit(1);
}

const db = createPgDatabase(url, { max: 1 });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Migrations appliquées : ${applied.join(', ')}` : 'Base à jour : aucune migration à appliquer.');
} catch (error) {
  console.error(`Échec des migrations : ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
