/**
 * Synchronisation locale -> PostgreSQL réel (PGlite + migrations + RLS).
 * Chaque « appareil » a sa propre base IndexedDB ; le serveur est partagé.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ShopDatabase } from '../../src/db/database';
import {
  cancelOrder,
  countPendingOperations,
  createOrder,
  createProduct,
  enqueueOperation,
  resolveOperation,
  updateProduct,
} from '../../src/db/repo';
import { newId } from '../../src/lib/ids';
import { runSync, type SyncReport } from '../../src/sync/engine';
import { uniqueDbName } from '../helpers/names';
import { asAdmin, asUser, countRows, createShopFor, createTestDatabase, createUser, flaky, pgliteDatabase, stockDrift } from '../helpers/pg';
import { startTestApi, type TestApi } from '../helpers/api';
import { ServerError, TransportError } from '../../src/sync/remote';
import type { ProductFormValues } from '../../src/domain/validation';

let pg: PGlite;
let api: TestApi;
const devices: ShopDatabase[] = [];
const dbNames: string[] = [];

beforeAll(async () => {
  pg = await createTestDatabase();
  api = await startTestApi(pgliteDatabase(pg));
});

afterAll(async () => {
  await api.close();
  await pg.close();
});

afterEach(async () => {
  for (const d of devices.splice(0)) d.close();
  for (const n of dbNames.splice(0)) await new ShopDatabase(n).delete();
});

interface Device {
  db: ShopDatabase;
  ctl: ReturnType<typeof flaky>['ctl'];
  sent: string[];
  sync: () => Promise<SyncReport>;
}

/** Ouvre un appareil (base locale neuve) connecté au compte donné. */
async function device(userId: string, shopId: string): Promise<Device> {
  const name = uniqueDbName('device');
  dbNames.push(name);
  const db = new ShopDatabase(name);
  await db.open();
  devices.push(db);
  const { remote, ctl, sent } = flaky(api.remoteFor(userId));
  return {
    db,
    ctl,
    sent,
    sync: () => runSync({ db, remote, shopId }),
  };
}

async function newAccount(label: string) {
  const userId = await createUser(pg, label);
  const shopId = await createShopFor(pg, userId, `Boutique ${label}`);
  return { userId, shopId };
}

function product(over: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: 'Brume vanille',
    category: 'Brumes',
    purchase_price: 2500,
    sale_price: 5000,
    alert_threshold: 2,
    initial_quantity: 10,
    ...over,
  };
}

async function serverProduct(id: string) {
  await asAdmin(pg);
  const { rows } = await pg.query<{ name: string; quantity: number; sale_price: number; version: number }>(
    'select name, quantity::int as quantity, sale_price::int as sale_price, version::int as version from public.products where id = $1',
    [id],
  );
  return rows[0];
}

describe('pousser le catalogue et le stock vers le serveur', () => {
  it('envoie les articles, confirme la réception avant d’annoncer le succès, et aligne les versions', async () => {
    const { userId, shopId } = await newAccount('sync1');
    const d = await device(userId, shopId);
    const a = await createProduct(d.db, shopId, product({ name: 'Brume', initial_quantity: 10 }));
    const b = await createProduct(d.db, shopId, product({ name: 'Bague', sale_price: 3000, purchase_price: 1000, initial_quantity: 5 }));

    const report = await d.sync();
    expect(report.outcome).toBe('synced');
    expect(report.pushed).toBe(2);
    expect(report.pulled).toBe(true);
    expect(await countPendingOperations(d.db)).toBe(0);

    const sa = await serverProduct(a.id);
    const sb = await serverProduct(b.id);
    expect(sa).toMatchObject({ name: 'Brume', quantity: 10, sale_price: 5000, version: 1 });
    expect(sb).toMatchObject({ name: 'Bague', quantity: 5, sale_price: 3000, version: 1 });
    expect((await d.db.products.get(a.id))?.sync_status).toBe('synced');
    expect((await d.db.products.get(a.id))?.version).toBe(1);
    expect(await stockDrift(pg, shopId)).toEqual([]);
  });
});

describe('hors ligne puis synchronisation (critique : offline puis sync, pas de doublon)', () => {
  it('envoie trois commandes faites hors ligne, une seule fois, et rejoue sans doublon', async () => {
    const { userId, shopId } = await newAccount('offline');
    const d = await device(userId, shopId);
    const p1 = await createProduct(d.db, shopId, product({ name: 'P1', initial_quantity: 10 }));
    const p2 = await createProduct(d.db, shopId, product({ name: 'P2', initial_quantity: 10 }));
    expect((await d.sync()).outcome).toBe('synced');

    d.ctl.down = true;
    await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: p1.id, quantity: 1 }], payment_method: 'cash' });
    await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: p1.id, quantity: 2 }, { product_id: p2.id, quantity: 1 }], payment_method: 'mobile_money' });
    await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: p2.id, quantity: 3 }], payment_method: 'other' });

    const offline = await d.sync();
    expect(offline.outcome).toBe('offline');
    expect(await countPendingOperations(d.db)).toBe(3);
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(0);
    // Le stock local reflète les ventes, même hors ligne
    expect((await d.db.products.get(p1.id))?.quantity).toBe(7);

    d.ctl.down = false;
    const online = await d.sync();
    expect(online.outcome).toBe('synced');
    expect(online.pushed).toBe(3);
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(3);
    expect(await countPendingOperations(d.db)).toBe(0);

    const serverP1 = await serverProduct(p1.id);
    const serverP2 = await serverProduct(p2.id);
    expect(serverP1.quantity).toBe(7);
    expect(serverP2.quantity).toBe(6);
    expect(await stockDrift(pg, shopId)).toEqual([]);

    // Second passage : rien à renvoyer, toujours 3 commandes
    const again = await d.sync();
    expect(again.pushed).toBe(0);
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(3);
  });

  it('rejouer manuellement une opération déjà appliquée ne crée pas de doublon', async () => {
    const { userId, shopId } = await newAccount('replay');
    const d = await device(userId, shopId);
    const p = await createProduct(d.db, shopId, product({ initial_quantity: 10 }));
    await d.sync();
    await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: p.id, quantity: 2 }], payment_method: 'cash' });
    const op = await d.db.sync_operations.where('type').equals('create_order').first();
    await d.sync();

    const remote = api.remoteFor(userId);
    const replay = await remote.apply({ op_id: op!.op_id, type: 'create_order', payload: op!.payload });
    expect(replay.duplicate).toBe(true);
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(1);
    expect((await serverProduct(p.id)).quantity).toBe(8);
  });

  it('réponse perdue après envoi : le nouvel essai ne crée pas de doublon', async () => {
    const { userId, shopId } = await newAccount('lost');
    const d = await device(userId, shopId);
    const p = await createProduct(d.db, shopId, product({ initial_quantity: 10 }));
    await d.sync();

    d.ctl.loseResponseNextApply = 1;
    await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' });
    const lost = await d.sync();
    expect(lost.outcome).toBe('offline');
    // Le serveur a bien enregistré la commande, mais le client ne le sait pas encore : il doit rester « en attente ».
    expect(await countPendingOperations(d.db)).toBe(1);
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(1);

    const retry = await d.sync();
    expect(retry.outcome).toBe('synced');
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(1);
    expect((await serverProduct(p.id)).quantity).toBe(9);
    expect((await d.db.products.get(p.id))?.quantity).toBe(9);
    expect(await stockDrift(pg, shopId)).toEqual([]);
  });

  it('échec réseau pendant l’envoi : l’opération reste en attente, puis part au retour de la connexion', async () => {
    const { userId, shopId } = await newAccount('netfail');
    const d = await device(userId, shopId);
    const p = await createProduct(d.db, shopId, product({ initial_quantity: 4 }));
    await d.sync();

    d.ctl.failNextApply = 1;
    await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' });
    const failed = await d.sync();
    expect(failed.outcome).toBe('offline');
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(0);
    const op = await d.db.sync_operations.where('type').equals('create_order').first();
    expect(op?.status).toBe('pending');
    expect(op?.attempts).toBe(1);
    expect(op?.last_error).toBeTruthy();

    expect((await d.sync()).outcome).toBe('synced');
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(1);
  });
});

describe('refus métier et conflits : rien n’est résolu en silence', () => {
  it('stock insuffisant après vente hors ligne sur un autre appareil : l’opération passe en échec, abandon explicite', async () => {
    const { userId, shopId } = await newAccount('stock');
    const a = await device(userId, shopId);
    const prod = await createProduct(a.db, shopId, product({ name: 'Collier', initial_quantity: 5 }));
    await a.sync();

    const b = await device(userId, shopId);
    await b.sync();

    a.ctl.down = true;
    await createOrder(a.db, shopId, { id: newId(), lines: [{ product_id: prod.id, quantity: 3 }], payment_method: 'cash' });
    expect((await a.sync()).outcome).toBe('offline');

    // L’autre appareil vend 4 pièces en ligne.
    await createOrder(b.db, shopId, { id: newId(), lines: [{ product_id: prod.id, quantity: 4 }], payment_method: 'cash' });
    expect((await b.sync()).outcome).toBe('synced');
    expect((await serverProduct(prod.id)).quantity).toBe(1);

    a.ctl.down = false;
    const report = await a.sync();
    expect(report.outcome).toBe('partial');
    expect(report.needsAttention).toBe(1);

    const failedOp = await a.db.sync_operations.where('status').equals('failed').first();
    expect(failedOp?.error_code).toBe('insufficient_stock');
    expect(failedOp?.last_error).toMatch(/Stock insuffisant/);
    expect(await countRows(pg, `select id from public.orders where shop_id = '${shopId}'`)).toBe(1);
    expect(await stockDrift(pg, shopId)).toEqual([]);

    // Abandon explicite : la commande locale est annulée et le stock local restauré.
    await resolveOperation(a.db, failedOp!.seq!, 'discard');
    expect((await a.db.products.get(prod.id))?.quantity).toBe(5);
    expect(await countPendingOperations(a.db)).toBe(0);

    const final = await a.sync();
    expect(final.outcome).toBe('synced');
    expect((await a.db.products.get(prod.id))?.quantity).toBe(1);
    expect(await stockDrift(pg, shopId)).toEqual([]);
  });

  it('conflit de version : refus silencieux interdit, la version locale est gardée jusqu’au choix explicite', async () => {
    const { userId, shopId } = await newAccount('conflict');
    const a = await device(userId, shopId);
    const prod = await createProduct(a.db, shopId, product({ name: 'Bracelet', sale_price: 5000, initial_quantity: 3 }));
    await a.sync();

    const b = await device(userId, shopId);
    await b.sync();
    const bLocal = (await b.db.products.get(prod.id))!;
    await updateProduct(b.db, prod.id, { ...bLocal, name: 'Bracelet', category: bLocal.category, purchase_price: bLocal.purchase_price, sale_price: 6000, alert_threshold: bLocal.alert_threshold, initial_quantity: 0 });
    expect((await b.sync()).outcome).toBe('synced');
    expect((await serverProduct(prod.id)).version).toBe(2);

    // A n’a pas vu le changement de prix ; il modifie le nom hors ligne.
    a.ctl.down = true;
    const aLocal = (await a.db.products.get(prod.id))!;
    await updateProduct(a.db, prod.id, { ...aLocal, name: 'Bracelet argent', category: aLocal.category, purchase_price: aLocal.purchase_price, sale_price: aLocal.sale_price, alert_threshold: aLocal.alert_threshold, initial_quantity: 0 });
    a.ctl.down = false;

    const report = await a.sync();
    expect(report.outcome).toBe('partial');
    const conflict = await a.db.sync_operations.where('status').equals('conflict').first();
    expect(conflict?.error_code).toBe('version_conflict');
    expect((await serverProduct(prod.id)).name).toBe('Bracelet');
    // Le téléchargement n’écrase pas la modification locale en attente de décision
    expect((await a.db.products.get(prod.id))?.name).toBe('Bracelet argent');

    await resolveOperation(a.db, conflict!.seq!, 'keep_local');
    expect((await a.sync()).outcome).toBe('synced');
    expect(await serverProduct(prod.id)).toMatchObject({ name: 'Bracelet argent', version: 3 });
  });

  it('conflit de version : choisir la version du serveur met à jour l’article local', async () => {
    const { userId, shopId } = await newAccount('conflict2');
    const a = await device(userId, shopId);
    const prod = await createProduct(a.db, shopId, product({ name: 'Anneau', sale_price: 4000, initial_quantity: 3 }));
    await a.sync();
    const b = await device(userId, shopId);
    await b.sync();

    const bLocal = (await b.db.products.get(prod.id))!;
    await updateProduct(b.db, prod.id, { ...bLocal, name: 'Anneau doré', category: bLocal.category, purchase_price: bLocal.purchase_price, sale_price: 4500, alert_threshold: bLocal.alert_threshold, initial_quantity: 0 });
    await b.sync();

    a.ctl.down = true;
    const aLocal = (await a.db.products.get(prod.id))!;
    await updateProduct(a.db, prod.id, { ...aLocal, name: 'Anneau local', category: aLocal.category, purchase_price: aLocal.purchase_price, sale_price: 3500, alert_threshold: aLocal.alert_threshold, initial_quantity: 0 });
    a.ctl.down = false;
    await a.sync();

    const conflict = await a.db.sync_operations.where('status').equals('conflict').first();
    await resolveOperation(a.db, conflict!.seq!, 'use_server');
    const local = await a.db.products.get(prod.id);
    expect(local).toMatchObject({ name: 'Anneau doré', sale_price: 4500, version: 2 });
    expect(await countPendingOperations(a.db)).toBe(0);
    expect(await serverProduct(prod.id)).toMatchObject({ name: 'Anneau doré', version: 2 });
  });

  it('erreur côté serveur : l’opération est marquée en échec et rien n’est écrit', async () => {
    const { userId, shopId } = await newAccount('servererr');
    const d = await device(userId, shopId);
    const prod = await createProduct(d.db, shopId, product({ name: 'Ruban', sale_price: 1000, initial_quantity: 2 }));
    await d.sync();

    // Prix non numérique : le serveur lève une erreur de type, la transaction est annulée.
    await enqueueOperation(d.db, {
      type: 'upsert_product',
      entity_id: prod.id,
      payload: {
        shop_id: shopId,
        product: {
          id: prod.id, name: 'Ruban cassé', category: null, purchase_price: 1, sale_price: 'abc',
          quantity: 2, alert_threshold: 1, status: 'active', base_version: 1, updated_at: new Date().toISOString(),
        },
      },
    });
    const report = await d.sync();
    expect(report.outcome).toBe('partial');
    expect(report.needsAttention).toBe(1);
    const op = await d.db.sync_operations.where('status').equals('failed').first();
    expect(op?.error_code).toBe('server_error');
    expect((await serverProduct(prod.id)).name).toBe('Ruban');
  });
});

describe('annulation et prix : traçabilité côté serveur', () => {
  it('annulation synchronisée : commande conservée, stock restauré, mouvement d’annulation enregistré', async () => {
    const { userId, shopId } = await newAccount('cancel');
    const d = await device(userId, shopId);
    const prod = await createProduct(d.db, shopId, product({ initial_quantity: 10 }));
    await d.sync();
    const { order } = await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: prod.id, quantity: 4 }], payment_method: 'cash' });
    await d.sync();

    await cancelOrder(d.db, order.id, 'Erreur de saisie');
    expect((await d.sync()).outcome).toBe('synced');

    await asAdmin(pg);
    const { rows } = await pg.query<{ status: string; cancel_reason: string; total_amount: number; items: number }>(
      `select o.status, o.cancel_reason, o.total_amount::int as total_amount,
              (select count(*)::int from public.order_items i where i.order_id = o.id) as items
         from public.orders o where o.id = $1`,
      [order.id],
    );
    expect(rows[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'Erreur de saisie', total_amount: 20000, items: 1 });
    expect((await serverProduct(prod.id)).quantity).toBe(10);
    const { rows: mv } = await pg.query<{ type: string; reason: string | null }>(
      "select type, reason from public.stock_movements where order_id = $1 and type = 'cancel_restock'",
      [order.id],
    );
    expect(mv).toHaveLength(1);
    expect(mv[0].reason).toContain('Erreur de saisie');
    expect(await stockDrift(pg, shopId)).toEqual([]);
  });

  it('modifier le prix après une vente ne change pas la commande déjà envoyée (serveur)', async () => {
    const { userId, shopId } = await newAccount('price');
    const d = await device(userId, shopId);
    const prod = await createProduct(d.db, shopId, product({ sale_price: 5000, purchase_price: 2500, initial_quantity: 10 }));
    await d.sync();
    const { order } = await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: prod.id, quantity: 2 }], payment_method: 'cash' });
    await d.sync();

    const local = (await d.db.products.get(prod.id))!;
    await updateProduct(d.db, prod.id, { ...local, name: local.name, category: local.category, purchase_price: 3000, sale_price: 7000, alert_threshold: local.alert_threshold, initial_quantity: 0 });
    await d.sync();

    await asAdmin(pg);
    const { rows } = await pg.query<{ unit_price: number; unit_cost: number; total_amount: number }>(
      `select i.unit_price::int as unit_price, i.unit_cost::int as unit_cost, o.total_amount::int as total_amount
         from public.order_items i join public.orders o on o.id = i.order_id where o.id = $1`,
      [order.id],
    );
    expect(rows[0]).toEqual({ unit_price: 5000, unit_cost: 2500, total_amount: 10000 });
    expect((await serverProduct(prod.id)).sale_price).toBe(7000);
  });

  it('le serveur recalcule les totaux à partir des lignes, sans tenir compte du total envoyé', async () => {
    const { userId, shopId } = await newAccount('totals');
    const d = await device(userId, shopId);
    const prod = await createProduct(d.db, shopId, product({ sale_price: 5000, purchase_price: 2500, initial_quantity: 10 }));
    await d.sync();
    await createOrder(d.db, shopId, { id: newId(), lines: [{ product_id: prod.id, quantity: 2 }], payment_method: 'cash' });
    const op = (await d.db.sync_operations.where('type').equals('create_order').first())!;
    const newOrderId = newId();
    const tampered = {
      ...op.payload,
      order: { ...(op.payload.order as Record<string, unknown>), id: newOrderId, total_amount: 1, total_cost: 1, total_quantity: 99 },
    };
    const result = await api.remoteFor(userId).apply({ op_id: newId(), type: 'create_order', payload: tampered });
    expect(result.status).toBe('applied');
    expect(result.total_amount).toBe(10000);
    expect(result.total_cost).toBe(5000);
    expect(result.total_quantity).toBe(2);
    await asAdmin(pg);
    const { rows } = await pg.query<{ total_amount: number; total_quantity: number }>(
      'select total_amount::int as total_amount, total_quantity::int as total_quantity from public.orders where id = $1',
      [newOrderId],
    );
    expect(rows[0]).toEqual({ total_amount: 10000, total_quantity: 2 });
  });
});

describe('nouvel appareil : restauration depuis le serveur', () => {
  it('récupère articles, commandes, annulations, mouvements et stock sur un appareil neuf', async () => {
    const { userId, shopId } = await newAccount('restore');
    const a = await device(userId, shopId);
    const p1 = await createProduct(a.db, shopId, product({ name: 'Crème', initial_quantity: 10 }));
    const p2 = await createProduct(a.db, shopId, product({ name: 'Savon', sale_price: 1500, purchase_price: 600, initial_quantity: 20 }));
    await a.sync();
    const o1 = await createOrder(a.db, shopId, { id: newId(), lines: [{ product_id: p1.id, quantity: 3 }, { product_id: p2.id, quantity: 2 }], payment_method: 'mobile_money' });
    const o2 = await createOrder(a.db, shopId, { id: newId(), lines: [{ product_id: p2.id, quantity: 1 }], payment_method: 'cash' });
    await cancelOrder(a.db, o2.order.id, 'Doublon');
    await a.sync();

    const b = await device(userId, shopId);
    const report = await b.sync();
    expect(report.outcome).toBe('synced');
    expect(report.pulled).toBe(true);

    expect(await b.db.products.count()).toBe(2);
    expect((await b.db.products.get(p1.id))?.quantity).toBe(7);
    // Savon : 20 - 2 (commande 1) - 1 (commande 2, annulée donc restituée) = 18
    expect((await b.db.products.get(p2.id))?.quantity).toBe(18);
    expect(await b.db.orders.count()).toBe(2);
    // Commande 1 : 3 × 5 000 + 2 × 1 500 = 18 000 FC
    expect((await b.db.orders.get(o1.order.id))?.total_amount).toBe(18000);
    expect((await b.db.orders.get(o2.order.id))?.status).toBe('cancelled');
    expect(await b.db.order_items.where('order_id').equals(o1.order.id).count()).toBe(2);
    expect(await b.db.stock_movements.count()).toBe(await countRows(pg, `select id from public.stock_movements where shop_id = '${shopId}'`));
  });
});

describe('isolation entre deux comptes (critique)', () => {
  it('le compte B ne voit ni ne modifie les données du compte A', async () => {
    const a = await newAccount('ownerA');
    const b = await newAccount('ownerB');
    const devA = await device(a.userId, a.shopId);
    const prod = await createProduct(devA.db, a.shopId, product({ name: 'Secret A', initial_quantity: 9 }));
    await devA.sync();
    await createOrder(devA.db, a.shopId, { id: newId(), lines: [{ product_id: prod.id, quantity: 1 }], payment_method: 'cash' });
    await devA.sync();

    // Le compte B interroge sa propre boutique : rien de celle de A
    const devB = await device(b.userId, b.shopId);
    const pulled = await api.remoteFor(b.userId).pull(b.shopId);
    expect(pulled.products).toEqual([]);
    expect(pulled.orders).toEqual([]);
    expect(pulled.movements).toEqual([]);

    // Lecture de la boutique A : refusée par le serveur (403), sans révéler le contenu
    const foreignPull = await api.remoteFor(b.userId).pull(a.shopId).catch((e: unknown) => e);
    expect(foreignPull).toBeInstanceOf(ServerError);
    expect((foreignPull as ServerError).code).toBe('forbidden_shop');

    // Tentative d’écriture dans la boutique A : refusée par la fonction serveur
    const foreignOp = {
      op_id: newId(),
      type: 'stock_movement' as const,
      payload: { shop_id: a.shopId, movement: { id: newId(), product_id: prod.id, delta: 100, type: 'entry', reason: 'Piratage' } },
    };
    await expect(api.remoteFor(b.userId).apply(foreignOp)).rejects.toMatchObject({ code: '42501' });
    expect((await devA.db.products.get(prod.id))?.quantity).toBe(8);
    expect(await stockDrift(pg, a.shopId)).toEqual([]);

    // Le compte B n’a aucune donnée locale du compte A après sa propre synchronisation
    await devB.sync();
    expect(await devB.db.products.count()).toBe(0);
    expect(await devB.db.orders.count()).toBe(0);
  });

  it('sans session, rien n’est envoyé : l’opération reste en attente (aucune écriture serveur)', async () => {
    const a = await newAccount('ownerC');
    const before = await countRows(pg, 'select id from public.products');
    const anonymous = api.remoteFor(null);
    await expect(anonymous.apply({ op_id: newId(), type: 'create_order', payload: { shop_id: a.shopId } })).rejects.toBeInstanceOf(TransportError);
    await expect(anonymous.pull(a.shopId)).rejects.toBeInstanceOf(TransportError);
    expect(await countRows(pg, 'select id from public.products')).toBe(before);
  });

  it('la RLS limite la lecture directe à la boutique du compte (défense en profondeur)', async () => {
    const a = await newAccount('rlsA');
    const b = await newAccount('rlsB');
    const devA = await device(a.userId, a.shopId);
    await createProduct(devA.db, a.shopId, product({ name: 'Visible A', initial_quantity: 3 }));
    await devA.sync();

    await asUser(pg, b.userId);
    const { rows } = await pg.query<{ name: string }>('select name from public.products');
    await asAdmin(pg);
    expect(rows).toEqual([]);

    await asUser(pg, a.userId);
    const own = await pg.query<{ name: string }>('select name from public.products');
    await asAdmin(pg);
    expect(own.rows.map((r) => r.name)).toEqual(['Visible A']);
  });
});
