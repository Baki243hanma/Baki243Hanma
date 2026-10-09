/**
 * Tests sur un vrai PostgreSQL (pilote « pg », rôle propriétaire non superutilisateur, comme Neon).
 *
 * Activés seulement si TEST_DATABASE_URL est définie, vers une base DÉDIÉE AUX TESTS (son nom doit
 * contenir « test » : le schéma public y est recréé). Exemple :
 *   TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/shopflow_test_db npx vitest run tests/integration/postgres.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgDatabase, migrate, withUser } from '../../server/db.js';
import { startTestApi, type TestApi } from '../helpers/api';
import { newId } from '../../src/lib/ids';

const URL_ = process.env.TEST_DATABASE_URL ?? '';
const enabled = URL_.length > 0;
if (enabled && !/test/i.test(new URL(URL_).pathname)) {
  throw new Error('TEST_DATABASE_URL doit pointer vers une base de test (nom contenant « test »).');
}

describe.skipIf(!enabled)('PostgreSQL réel : migrations, pilote pg et API', () => {
  const db = enabled ? createPgDatabase(URL_, { max: 3 }) : (null as unknown as ReturnType<typeof createPgDatabase>);
  let api: TestApi;

  beforeAll(async () => {
    await db.exec('drop schema public cascade; create schema public;');
    const applied = await migrate(db);
    expect(applied).toEqual(['001_init_schema.sql', '002_rls_security.sql', '003_sync_functions.sql']);
    api = await startTestApi(db);
  });

  afterAll(async () => {
    if (api) await api.close();
    if (db) await db.close();
  });

  it('les migrations sont appliquées une seule fois', async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it('withUser : l’identité est locale à la transaction et ne fuit pas vers le pool', async () => {
    const user = `leak-${randomUUID()}`;
    const inside = await withUser(db, user, (tx) => tx.query<{ v: string }>("select current_setting('app.user_id', true) as v"));
    expect(inside[0].v).toBe(user);
    const outside = await db.query<{ v: string | null }>("select nullif(current_setting('app.user_id', true), '') as v");
    expect(outside[0].v).toBeNull();
  });

  it('withUser refuse un identifiant vide (aucune transaction ouverte)', async () => {
    await expect(withUser(db, '', async () => 1)).rejects.toThrow(/identifiant/);
  });

  it('une erreur dans une transaction annule tout ce qui a été écrit', async () => {
    const user = `rollback-${randomUUID()}`;
    await expect(
      withUser(db, user, async (tx) => {
        await tx.query('select public.ensure_shop($1)', ['Boutique annulée']);
        throw new Error('arrêt volontaire');
      }),
    ).rejects.toThrow('arrêt volontaire');
    const rows = await db.query<{ n: number }>('select count(*)::int as n from public.shop_profiles where user_id = $1', [user]);
    expect(rows[0].n).toBe(0);
  });

  it('parcours complet via HTTP : boutique, article, commande, lecture, puis rejeu idempotent', async () => {
    const owner = `owner-${randomUUID()}`;
    const other = `other-${randomUUID()}`;
    const shop = (await (await fetch(`${api.baseUrl}/api/shop/ensure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await api.tokenFor(owner)}` },
      body: JSON.stringify({ name: 'Boutique PG' }),
    })).json()) as { id: string; created: boolean };
    expect(shop.created).toBe(true);

    const remote = api.remoteFor(owner);
    const productId = newId();
    const now = new Date().toISOString();
    const up = await remote.apply({
      op_id: newId(),
      type: 'upsert_product',
      payload: {
        shop_id: shop.id,
        product: { id: productId, name: 'Rouge à lèvres', category: 'Cosmétiques', purchase_price: 1500, sale_price: 4000, initial_quantity: 6, alert_threshold: 2, status: 'active', base_version: 0, created_at: now, updated_at: now },
      },
    });
    expect(up).toMatchObject({ status: 'applied', version: 1 });

    const orderId = newId();
    const createOpId = newId();
    const created = await remote.apply({
      op_id: createOpId,
      type: 'create_order',
      payload: {
        shop_id: shop.id,
        order: { id: orderId, payment_method: 'cash', created_at: now, total_amount: 1, total_cost: 1, total_quantity: 1 },
        items: [{ id: newId(), product_id: productId, product_name: 'Rouge à lèvres', unit_price: 4000, unit_cost: 1500, quantity: 2, movement_id: newId() }],
      },
    });
    expect(created.status).toBe('applied');

    const snap = await remote.pull(shop.id);
    expect(snap.shop).toMatchObject({ id: shop.id, name: 'Boutique PG' });
    expect(snap.products).toHaveLength(1);
    expect(snap.products[0]).toMatchObject({ id: productId, quantity: 4, sale_price: 4000 });
    expect(snap.orders[0]).toMatchObject({ id: orderId, total_amount: 8000, total_cost: 3000, total_quantity: 2 });
    expect(snap.orders[0].order_items).toHaveLength(1);
    expect(snap.movements.map((m) => m.type).sort()).toEqual(['initial', 'sale']);

    // Rejeu de la même commande : pas de doublon, stock inchangé
    const replay = await remote.apply({
      op_id: createOpId,
      type: 'create_order',
      payload: { shop_id: shop.id, order: { id: orderId, payment_method: 'cash', created_at: now }, items: [{ id: newId(), product_id: productId, product_name: 'Rouge à lèvres', unit_price: 4000, unit_cost: 1500, quantity: 2, movement_id: newId() }] },
    });
    expect(replay.duplicate).toBe(true);
    const after = await remote.pull(shop.id);
    expect(after.orders).toHaveLength(1);
    expect(after.products[0].quantity).toBe(4);

    // L'autre compte ne voit rien
    const foreign = await api.remoteFor(other).pull(shop.id).catch((e: unknown) => e);
    expect((foreign as { code?: string }).code).toBe('forbidden_shop');
  });

  it('une opération visant une boutique étrangère est refusée par la base réelle (42501)', async () => {
    const victim = `victim-${randomUUID()}`;
    const attacker = `attacker-${randomUUID()}`;
    const shopRows = await withUser(db, victim, (tx) => tx.query<{ r: { id: string } }>('select public.ensure_shop($1) as r', ['Cible']));
    const shopId = shopRows[0].r.id;
    const err = await api
      .remoteFor(attacker)
      .apply({ op_id: newId(), type: 'stock_movement', payload: { shop_id: shopId, movement: { id: newId(), product_id: newId(), delta: 5, type: 'entry', reason: 'x' } } })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('42501');
  });
});
