/**
 * Base PostgreSQL réelle en mémoire (PGlite) avec les migrations du dossier supabase/migrations.
 * Simule Supabase : schéma auth (auth.users, auth.uid()), rôles anon / authenticated, RLS.
 * Un « adaptateur distant » implémente RemoteAdapter en appelant les mêmes fonctions SQL que l'application.
 */
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpType } from '../../src/domain/types';
import { ServerError, TransportError, type RemoteAdapter, type RemoteResult, type RemoteSnapshot } from '../../src/sync/remote';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');

const SUPABASE_STUB_SQL = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema public to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
`;

export async function createTestDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB_SQL);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return pg;
}

/** Crée un compte (auth.users) et renvoie son identifiant. */
export async function createUser(pg: PGlite, label: string): Promise<string> {
  await asAdmin(pg);
  const { rows } = await pg.query<{ id: string }>(
    'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id',
    [`${label}@example.test`],
  );
  return rows[0].id;
}

/** Rôle propriétaire (contourne la RLS) : à utiliser uniquement pour préparer ou vérifier les données. */
export async function asAdmin(pg: PGlite): Promise<void> {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', '', false)");
}

/** Session comme dans Supabase : rôle authenticated avec l'identifiant du compte, ou anon si null. */
export async function asUser(pg: PGlite, userId: string | null): Promise<void> {
  await pg.exec('reset role');
  if (!userId) {
    await pg.query("select set_config('request.jwt.claim.sub', '', false)");
    await pg.exec('set role anon');
    return;
  }
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await pg.exec('set role authenticated');
}

/** Crée (ou récupère) la boutique du compte via la fonction publique ensure_shop. */
export async function createShopFor(pg: PGlite, userId: string, name = 'Boutique test'): Promise<string> {
  await asUser(pg, userId);
  const { rows } = await pg.query<{ r: { id: string } }>('select public.ensure_shop($1) as r', [name]);
  await asAdmin(pg);
  return rows[0].r.id;
}

function toRemoteError(error: unknown): Error {
  const e = error as { code?: string; message?: string };
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    return new ServerError(e.code, e.message ?? 'Erreur serveur');
  }
  return new TransportError();
}

/** Adaptateur distant branché sur la base PGlite, avec la session d'un compte donné. */
export function pgRemote(pg: PGlite, userId: string | null): RemoteAdapter {
  return {
    async apply(op) {
      await asUser(pg, userId);
      try {
        const { rows } = await pg.query<{ result: RemoteResult }>(
          'select public.apply_sync_operation($1::uuid, $2::text, $3::jsonb) as result',
          [op.op_id, op.type, JSON.stringify(op.payload)],
        );
        return rows[0].result;
      } catch (error) {
        throw toRemoteError(error);
      } finally {
        await asAdmin(pg);
      }
    },

    async pull(shopId) {
      await asUser(pg, userId);
      try {
        const shop = await pg.query<{ j: { id: string; name: string } }>(
          'select to_jsonb(s) as j from public.shops s where s.id = $1',
          [shopId],
        );
        const products = await pg.query<{ j: RemoteSnapshot['products'][number] }>(
          'select to_jsonb(p) as j from public.products p where p.shop_id = $1 order by p.id',
          [shopId],
        );
        const orders = await pg.query<{ j: RemoteSnapshot['orders'][number] }>(
          `select to_jsonb(o) || jsonb_build_object('order_items',
             coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id), '[]'::jsonb)
           ) as j
           from public.orders o where o.shop_id = $1 order by o.id`,
          [shopId],
        );
        const movements = await pg.query<{ j: RemoteSnapshot['movements'][number] }>(
          'select to_jsonb(m) as j from public.stock_movements m where m.shop_id = $1 order by m.id',
          [shopId],
        );
        return {
          shop: shop.rows[0]?.j ?? null,
          products: products.rows.map((r) => r.j),
          orders: orders.rows.map((r) => r.j),
          movements: movements.rows.map((r) => r.j),
        };
      } catch (error) {
        throw toRemoteError(error);
      } finally {
        await asAdmin(pg);
      }
    },
  };
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

export type { OpType };
