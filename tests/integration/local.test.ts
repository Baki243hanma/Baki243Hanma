/**
 * Tests de la couche locale (IndexedDB via Dexie) : catalogue, commandes, stock, annulations,
 * historique des prix, tableau de bord et persistance après fermeture.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShopDatabase } from '../../src/db/database';
import {
  addStockEntry,
  adjustStock,
  BusinessError,
  cancelOrder,
  createOrder,
  createProduct,
  setProductArchived,
  updateProduct,
} from '../../src/db/repo';
import { loadDashboard } from '../../src/db/queries';
import { computePeriod } from '../../src/lib/dates';
import { newId } from '../../src/lib/ids';
import type { ProductFormValues } from '../../src/domain/validation';
import { uniqueDbName } from '../helpers/names';

const SHOP = newId();

function product(over: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: 'Brume vanille',
    category: 'Brumes',
    purchase_price: 2500,
    sale_price: 5000,
    alert_threshold: 3,
    initial_quantity: 10,
    ...over,
  };
}

let db: ShopDatabase;
let name: string;

beforeEach(async () => {
  name = uniqueDbName();
  db = new ShopDatabase(name);
  await db.open();
});

afterEach(async () => {
  db.close();
  await new ShopDatabase(name).delete();
});

describe('1. créer un produit et consulter son stock', () => {
  it('enregistre l’article, son stock initial et une opération en attente', async () => {
    const p = await createProduct(db, SHOP, product());
    const stored = await db.products.get(p.id);
    expect(stored?.quantity).toBe(10);
    expect(stored?.sale_price).toBe(5000);
    expect(stored?.status).toBe('active');
    expect(stored?.sync_status).toBe('pending');

    const movements = await db.stock_movements.where('product_id').equals(p.id).toArray();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'initial', quantity_delta: 10, quantity_after: 10 });

    const ops = await db.sync_operations.toArray();
    expect(ops.map((o) => o.type)).toEqual(['upsert_product']);
    expect(ops[0].status).toBe('pending');
  });

  it('refuse un prix de vente nul et un nom vide', async () => {
    await expect(createProduct(db, SHOP, product({ sale_price: 0 }))).rejects.toBeInstanceOf(BusinessError);
    await expect(createProduct(db, SHOP, product({ name: '   ' }))).rejects.toBeInstanceOf(BusinessError);
    expect(await db.products.count()).toBe(0);
  });
});

describe('2-4. commandes : un article, trois articles, calcul du total', () => {
  it('enregistre une commande avec un seul article', async () => {
    const p = await createProduct(db, SHOP, product());
    const { order, items } = await createOrder(db, SHOP, {
      id: newId(),
      lines: [{ product_id: p.id, quantity: 2 }],
      payment_method: 'cash',
    });
    expect(items).toHaveLength(1);
    expect(order.total_amount).toBe(10000);
    expect(order.total_cost).toBe(5000);
    expect(order.gross_margin).toBe(5000);
    expect(order.total_quantity).toBe(2);
    expect(order.status).toBe('confirmed');
    expect(items[0]).toMatchObject({ product_name: 'Brume vanille', unit_price: 5000, unit_cost: 2500, line_total: 10000, line_cost: 5000 });
  });

  it('enregistre une commande de trois produits différents et calcule le total exact', async () => {
    const a = await createProduct(db, SHOP, product({ name: 'Brume', sale_price: 5000, purchase_price: 2500, initial_quantity: 10 }));
    const b = await createProduct(db, SHOP, product({ name: 'Bague', sale_price: 3000, purchase_price: 1000, initial_quantity: 5 }));
    const c = await createProduct(db, SHOP, product({ name: 'Collier', sale_price: 8000, purchase_price: 4000, initial_quantity: 2 }));

    const { order, items } = await createOrder(db, SHOP, {
      id: newId(),
      lines: [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 1 },
        { product_id: c.id, quantity: 1 },
      ],
      payment_method: 'mobile_money',
    });
    expect(items).toHaveLength(3);
    expect(order.total_amount).toBe(21000); // 2×5 000 + 3 000 + 8 000
    expect(order.total_cost).toBe(10000); // 2×2 500 + 1 000 + 4 000
    expect(order.gross_margin).toBe(11000);
    expect(order.total_quantity).toBe(4);
    expect(order.payment_method).toBe('mobile_money');
    expect(await db.orders.count()).toBe(1);
    expect(await db.order_items.where('order_id').equals(order.id).count()).toBe(3);
  });

  it('refuse une commande vide, une quantité nulle ou négative, et un doublon de ligne', async () => {
    const p = await createProduct(db, SHOP, product());
    await expect(createOrder(db, SHOP, { id: newId(), lines: [], payment_method: 'cash' })).rejects.toThrow(/au moins un article/);
    await expect(createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 0 }], payment_method: 'cash' })).rejects.toThrow(/supérieurs à 0/);
    await expect(createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: -1 }], payment_method: 'cash' })).rejects.toThrow(/supérieurs à 0/);
    await expect(
      createOrder(db, SHOP, {
        id: newId(),
        lines: [
          { product_id: p.id, quantity: 1 },
          { product_id: p.id, quantity: 1 },
        ],
        payment_method: 'cash',
      }),
    ).rejects.toThrow(/une seule fois/);
    expect(await db.orders.count()).toBe(0);
    expect((await db.products.get(p.id))?.quantity).toBe(10);
  });
});

describe('5-6. stock : diminution et refus de vente au-delà du stock', () => {
  it('diminue le stock et enregistre un mouvement de vente', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 10 }));
    const { order } = await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 3 }], payment_method: 'cash' });
    expect((await db.products.get(p.id))?.quantity).toBe(7);
    const sale = await db.stock_movements.where('order_id').equals(order.id).first();
    expect(sale).toMatchObject({ type: 'sale', quantity_delta: -3, quantity_after: 7, product_id: p.id });
  });

  it('refuse une vente supérieure au stock et n’écrit rien (pas de commande partielle)', async () => {
    const a = await createProduct(db, SHOP, product({ name: 'A', initial_quantity: 5 }));
    const b = await createProduct(db, SHOP, product({ name: 'B', initial_quantity: 1 }));
    await expect(
      createOrder(db, SHOP, {
        id: newId(),
        lines: [
          { product_id: a.id, quantity: 2 },
          { product_id: b.id, quantity: 2 },
        ],
        payment_method: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });

    expect(await db.orders.count()).toBe(0);
    expect(await db.order_items.count()).toBe(0);
    expect((await db.products.get(a.id))?.quantity).toBe(5);
    expect((await db.products.get(b.id))?.quantity).toBe(1);
    expect(await db.sync_operations.where('type').equals('create_order').count()).toBe(0);
  });

  it('permet d’épuiser exactement le stock puis refuse la vente suivante', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 2 }));
    await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 2 }], payment_method: 'cash' });
    expect((await db.products.get(p.id))?.quantity).toBe(0);
    await expect(createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' })).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
  });

  it('deux ventes simultanées sur le dernier article : une seule réussit', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 1 }));
    const results = await Promise.allSettled([
      createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' }),
      createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.orders.count()).toBe(1);
    expect((await db.products.get(p.id))?.quantity).toBe(0);
  });

  it('une double validation avec le même identifiant ne crée qu’une commande', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 10 }));
    const id = newId();
    await createOrder(db, SHOP, { id, lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' });
    await expect(createOrder(db, SHOP, { id, lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' })).rejects.toThrow(/déjà été enregistrée/);
    expect(await db.orders.count()).toBe(1);
    expect((await db.products.get(p.id))?.quantity).toBe(9);
  });

  it('enregistre une entrée de stock et une correction motivée, sans stock négatif', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 4 }));
    await addStockEntry(db, p.id, 6, 'Livraison');
    expect((await db.products.get(p.id))?.quantity).toBe(10);
    await adjustStock(db, p.id, -3, 'Inventaire : casse');
    expect((await db.products.get(p.id))?.quantity).toBe(7);
    await expect(adjustStock(db, p.id, -50, 'Erreur')).rejects.toMatchObject({ code: 'insufficient_stock' });
    await expect(adjustStock(db, p.id, -1, '')).rejects.toMatchObject({ code: 'reason_required' });
    const types = (await db.stock_movements.where('product_id').equals(p.id).toArray()).map((m) => m.type).sort();
    expect(types).toEqual(['correction', 'entry', 'initial']);
  });
});

describe('8. modifier le prix : l’ancienne commande reste inchangée', () => {
  it('garde le prix et le coût du moment dans les lignes existantes', async () => {
    const p = await createProduct(db, SHOP, product({ sale_price: 5000, purchase_price: 2500 }));
    const { order } = await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 2 }], payment_method: 'cash' });

    await updateProduct(db, p.id, product({ name: 'Brume vanille 200 ml', sale_price: 7000, purchase_price: 3000, initial_quantity: 0 }));

    const items = await db.order_items.where('order_id').equals(order.id).toArray();
    expect(items[0]).toMatchObject({ product_name: 'Brume vanille', unit_price: 5000, unit_cost: 2500, line_total: 10000 });
    const stored = await db.orders.get(order.id);
    expect(stored?.total_amount).toBe(10000);
    expect(stored?.gross_margin).toBe(5000);
    expect((await db.products.get(p.id))?.sale_price).toBe(7000);
  });

  it('fusionne plusieurs modifications non envoyées dans une seule opération', async () => {
    const p = await createProduct(db, SHOP, product());
    await updateProduct(db, p.id, product({ name: 'Brume A' }));
    await updateProduct(db, p.id, product({ name: 'Brume B', sale_price: 6000 }));
    const ops = await db.sync_operations.where('entity_id').equals(p.id).toArray();
    const upserts = ops.filter((o) => o.type === 'upsert_product');
    expect(upserts).toHaveLength(1);
    expect((upserts[0].payload as { product: { name: string; sale_price: number } }).product).toMatchObject({ name: 'Brume B', sale_price: 6000 });
  });
});

describe('9. annuler une commande : traçabilité et restauration du stock', () => {
  it('conserve la commande, restaure le stock et journalise l’annulation', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 10 }));
    const { order } = await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 4 }], payment_method: 'cash' });
    expect((await db.products.get(p.id))?.quantity).toBe(6);

    await cancelOrder(db, order.id, 'Le client a annulé');

    const stored = await db.orders.get(order.id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.cancel_reason).toBe('Le client a annulé');
    expect(stored?.cancelled_at).toBeTruthy();
    expect(stored?.total_amount).toBe(20000); // la commande d’origine n’est pas effacée
    expect((await db.products.get(p.id))?.quantity).toBe(10);

    const movements = await db.stock_movements.where('order_id').equals(order.id).toArray();
    expect(movements.map((m) => m.type).sort()).toEqual(['cancel_restock', 'sale']);
    const restock = movements.find((m) => m.type === 'cancel_restock');
    expect(restock).toMatchObject({ quantity_delta: 4, quantity_after: 10 });
    expect(restock?.reason).toContain('Le client a annulé');

    const cancelOp = await db.sync_operations.where('type').equals('cancel_order').first();
    expect(cancelOp?.status).toBe('pending');
  });

  it('exige un motif et refuse une seconde annulation', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 10 }));
    const { order } = await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' });
    await expect(cancelOrder(db, order.id, '  ')).rejects.toMatchObject({ code: 'reason_required' });
    await cancelOrder(db, order.id, 'Erreur de saisie');
    await expect(cancelOrder(db, order.id, 'Erreur de saisie')).rejects.toMatchObject({ code: 'already_cancelled' });
    expect((await db.products.get(p.id))?.quantity).toBe(10);
  });
});

describe('articles archivés', () => {
  it('un article archivé ne peut plus être vendu, mais son historique reste', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 5 }));
    await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' });
    await setProductArchived(db, p.id, true);
    expect(await db.products.get(p.id)).toMatchObject({ status: 'archived' });
    await expect(createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 1 }], payment_method: 'cash' })).rejects.toMatchObject({
      code: 'archived',
    });
    expect(await db.stock_movements.where('product_id').equals(p.id).count()).toBe(2);
    await setProductArchived(db, p.id, false);
    expect((await db.products.get(p.id))?.status).toBe('active');
  });
});

describe('10. fermer puis rouvrir : les données locales persistent', () => {
  it('retrouve produits, commandes, mouvements et file d’attente après réouverture', async () => {
    const p = await createProduct(db, SHOP, product({ initial_quantity: 10 }));
    const { order } = await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: p.id, quantity: 2 }], payment_method: 'other' });
    await db.meta.put({ key: 'draftOrder', value: { id: 'x', lines: [], payment: null } });
    db.close();

    const reopened = new ShopDatabase(name);
    await reopened.open();
    try {
      expect((await reopened.products.get(p.id))?.quantity).toBe(8);
      expect((await reopened.orders.get(order.id))?.total_amount).toBe(10000);
      expect(await reopened.order_items.where('order_id').equals(order.id).count()).toBe(1);
      expect(await reopened.stock_movements.count()).toBe(2);
      expect(await reopened.sync_operations.where('status').equals('pending').count()).toBe(2);
    } finally {
      reopened.close();
    }
    db = new ShopDatabase(name);
    await db.open();
  });
});

describe('tableau de bord : calculs à partir des données réelles', () => {
  it('ne compte que les commandes confirmées et calcule CA, coût, marge et quantités', async () => {
    const a = await createProduct(db, SHOP, product({ name: 'Brume', sale_price: 5000, purchase_price: 2500, initial_quantity: 10 }));
    const b = await createProduct(db, SHOP, product({ name: 'Bague', sale_price: 3000, purchase_price: 1000, initial_quantity: 5, alert_threshold: 4 }));
    const o1 = await createOrder(db, SHOP, {
      id: newId(),
      lines: [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 1 },
      ],
      payment_method: 'cash',
    });
    const o2 = await createOrder(db, SHOP, { id: newId(), lines: [{ product_id: a.id, quantity: 1 }], payment_method: 'cash' });
    await cancelOrder(db, o2.order.id, 'Erreur de saisie');

    const period = computePeriod('all', new Date());
    const data = await loadDashboard(db, period);
    expect(data.orderCount).toBe(1);
    expect(data.revenue).toBe(13000);
    expect(data.cost).toBe(6000);
    expect(data.grossMargin).toBe(7000);
    expect(data.quantitySold).toBe(3);
    expect(data.marginPercent).toBe(54);
    // Valeur du stock au coût : Brume 10 − 2 (o1) − 1 (o2) + 1 (annulation de o2) = 8 ; Bague 5 − 1 (o1) = 4
    expect(data.stockValue).toBe(8 * 2500 + 4 * 1000);
    expect(data.lowStock.map((p) => p.name)).toEqual(['Bague']);
    expect(data.recentOrders.length).toBe(2);
    expect(o1.order.id).toBeTruthy();
  });

  it('affiche des valeurs nulles, sans fausse donnée, quand il n’y a aucune vente', async () => {
    await createProduct(db, SHOP, product({ initial_quantity: 3 }));
    const data = await loadDashboard(db, computePeriod('today', new Date()));
    expect(data.orderCount).toBe(0);
    expect(data.revenue).toBe(0);
    expect(data.grossMargin).toBe(0);
    expect(data.series).toEqual([]);
    expect(data.hasAnyProduct).toBe(true);
    expect(data.hasAnyOrder).toBe(false);
  });
});
