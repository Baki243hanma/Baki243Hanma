/**
 * Accès à PostgreSQL (Neon) côté serveur.
 *
 * - createPgDatabase : adaptateur fondé sur le paquet « pg » (DATABASE_URL, jamais exposée au navigateur).
 * - withUser : exécute une fonction dans une transaction où l'identifiant vérifié du compte est
 *   fixé par set_config('app.user_id', …, true). Les fonctions SQL lisent cet identifiant via
 *   public.current_user_id(). La valeur est locale à la transaction : elle ne fuit pas vers une
 *   autre requête partageant le même pool.
 * - migrate : applique les fichiers db/migrations/*.sql une seule fois, sous verrou consultatif.
 *
 * Un adaptateur expose : query(sql, params) -> lignes, exec(sql), transaction(fn(tx)), close().
 */
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export function createPgDatabase(connectionString, { max = 5 } = {}) {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });

  return {
    async query(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const tx = {
          query: async (sql, params = []) => (await client.query(sql, params)).rows,
          exec: async (sql) => {
            await client.query(sql);
          },
        };
        const result = await fn(tx);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Exécute fn dans une transaction dont l'identité est celle du compte vérifié. */
export async function withUser(db, userId, fn) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('withUser : identifiant de compte manquant');
  }
  return db.transaction(async (tx) => {
    await tx.query("select set_config('app.user_id', $1, true)", [userId]);
    return fn(tx);
  });
}

/**
 * Applique les migrations en attente, dans l'ordre des noms de fichiers.
 * Chaque migration est une transaction ; un verrou consultatif évite les exécutions concurrentes.
 * Retourne la liste des fichiers appliqués lors de cet appel.
 */
export async function migrate(db, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  await db.exec(`
    create table if not exists public.schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = [];

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const didApply = await db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', ['shopflow-rdc-migrations']);
      const seen = await tx.query('select 1 as found from public.schema_migrations where name = $1', [file]);
      if (seen.length > 0) return false;
      await tx.exec(sql);
      await tx.query('insert into public.schema_migrations (name) values ($1)', [file]);
      return true;
    });
    if (didApply) applied.push(file);
  }
  return applied;
}
