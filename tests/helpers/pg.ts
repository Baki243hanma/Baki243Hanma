/**
 * Base PostgreSQL réelle en mémoire (PGlite) avec les migrations de db/migrations, appliquées
 * par le même migrateur que le serveur (server/db.js).
 *
 * Simulation de la production :
 *  - le serveur (rôle propriétaire) appelle les fonctions SQL après vérification du jeton ;
 *  - « app_reader » est un rôle sans écriture soumis à la RLS : il sert à vérifier que la RLS
 *    refuse les lectures hors de la boutique, même si une requête atteignait la base directement.
 */
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, withUser } from '../../server/db.js';
import type { Database } from '../../server/app.js';
import { TransportError, type RemoteAdapter } from '../../src/sync/remote';

const READER_SETUP_SQL = `
  create role app_reader nologin;
  grant usage on schema public to app_reader;
  alter default privileges in schema public grant select on tables to app_reader;
`;

export async function createTestDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(READER_SETUP_SQL);
  await migrate(pgliteDatabase(pg));
  await pg.exec(`
    grant execute on function public.current_user_id() to app_reader;
    grant execute on function public.is_shop_member(uuid) to app_reader;
  `);
  return pg;
}

/** Adaptateur Database (même interface que server/db.js) fondé sur PGlite. */
export function pgliteDatabase(pg: PGlite): Database {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query(sql, params)).rows as T[];
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    async transaction(fn) {
      return pg.transaction((tx) =>
        fn({
          query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await tx.query(sql, params)).rows as T[],
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
}

/** Identifiant de compte façon Neon Auth (valeur « sub » d'un JWT). */
export async function createUser(_pg: PGlite, label: string): Promise<string> {
  return `${label}-${randomUUID()}`;
}

/** Rôle propriétaire (contourne la RLS) : pour préparer ou vérifier les données. */
export async function asAdmin(pg: PGlite): Promise<void> {
  await pg.exec('reset role');
  await pg.query("select set_config('app.user_id', '', false)");
}

/** Session du rôle de lecture soumis à la RLS, identifiée par userId (ou sans identité si null). */
export async function asUser(pg: PGlite, userId: string | null): Promise<void> {
  await pg.exec('reset role');
  await pg.query("select set_config('app.user_id', $1, false)", [userId ?? '']);
  await pg.exec('set role app_reader');
}

/** Crée (ou récupère) la boutique du compte via la fonction publique ensure_shop, comme le serveur. */
export async function createShopFor(pg: PGlite, userId: string, name = 'Boutique test'): Promise<string> {
  await asAdmin(pg);
  const rows = await withUser(pgliteDatabase(pg), userId, (tx) => tx.query<{ r: { id: string } }>('select public.ensure_shop($1) as r', [name]));
  return rows[0].r.id;
}

export interface FlakyControls {
  /** Hors ligne : tout appel échoue avant d'atteindre le serveur. */
  down: boolean;
  /** Nombre d'envois qui échouent avant d'atteindre le serveur (fetch échoué). */
  failNextApply: number;
  /** Nombre d'envois dont la réponse est perdue : le serveur applique, le client reçoit une erreur. */
  loseResponseNextApply: number;
}

/** Enveloppe un adaptateur pour simuler les pannes réseau. */
export function flaky(inner: RemoteAdapter): { remote: RemoteAdapter; ctl: FlakyControls; sent: string[] } {
  const ctl: FlakyControls = { down: false, failNextApply: 0, loseResponseNextApply: 0 };
  const sent: string[] = [];
  const remote: RemoteAdapter = {
    async apply(op) {
      if (ctl.down) throw new TransportError();
      if (ctl.failNextApply > 0) {
        ctl.failNextApply -= 1;
        throw new TypeError('Failed to fetch');
      }
      sent.push(op.op_id);
      const result = await inner.apply(op);
      if (ctl.loseResponseNextApply > 0) {
        ctl.loseResponseNextApply -= 1;
        throw new TransportError('La réponse du serveur n’a pas été reçue.');
      }
      return result;
    },
    async pull(shopId) {
      if (ctl.down) throw new TransportError();
      return inner.pull(shopId);
    },
  };
  return { remote, ctl, sent };
}

/** Vérifie qu'aucun article n'a un stock différent de la somme de ses mouvements. */
export async function stockDrift(pg: PGlite, shopId: string): Promise<Array<{ id: string; quantity: number; moved: number }>> {
  await asAdmin(pg);
  const { rows } = await pg.query<{ id: string; quantity: number; moved: number }>(
    `select p.id, p.quantity::int as quantity, coalesce(sum(m.quantity_delta), 0)::int as moved
       from public.products p
       left join public.stock_movements m on m.product_id = p.id
      where p.shop_id = $1
      group by p.id, p.quantity
     having p.quantity <> coalesce(sum(m.quantity_delta), 0)`,
    [shopId],
  );
  return rows;
}

export async function countRows(pg: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  await asAdmin(pg);
  const { rows } = await pg.query<{ n: number }>(`select count(*)::int as n from (${sql}) as q`, params);
  return rows[0].n;
}
