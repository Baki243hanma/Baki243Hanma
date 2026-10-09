/**
 * Base locale IndexedDB (via Dexie).
 *
 * Une base par compte (ou une base « locale » en mode sans compte), pour qu'un même
 * téléphone ne mélange jamais les données de deux commerçants.
 */
import Dexie, { type Table } from 'dexie';
import type { MetaEntry, Order, OrderItem, Product, StockMovement, SyncOperation } from '../domain/types';

export class ShopDatabase extends Dexie {
  products!: Table<Product, string>;
  orders!: Table<Order, string>;
  order_items!: Table<OrderItem, string>;
  stock_movements!: Table<StockMovement, string>;
  sync_operations!: Table<SyncOperation, number>;
  meta!: Table<MetaEntry, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      products: 'id, shop_id, status, category, name, sync_status',
      orders: 'id, created_at, status, sync_status',
      order_items: 'id, order_id, product_id',
      stock_movements: 'id, product_id, order_id, created_at',
      sync_operations: '++seq, &op_id, status, entity_id, type, created_at',
      meta: 'key',
    });
  }
}

/** Nom de la base IndexedDB selon le mode. */
export function databaseName(userId: string | null): string {
  return userId ? `shopflow-rdc:${userId}` : 'shopflow-rdc:local';
}
