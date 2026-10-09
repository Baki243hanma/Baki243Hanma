/**
 * Couche d'écriture LOCALE (IndexedDB).
 *
 * Chaque action métier est une transaction Dexie qui écrit ensemble :
 *  - les données métier (produits, commandes, lignes, mouvements de stock),
 *  - l'opération correspondante dans la file de synchronisation (sync_operations).
 * Si une étape échoue, rien n'est écrit (pas de commande partielle).
 */
import { orderTotals, type PricedLine } from '../lib/calc';
import { multiplyAmount } from '../lib/money';
import { newId } from '../lib/ids';
import { validatePaymentMethod, validateProduct, validateReason, type ProductFormValues } from '../domain/validation';
import type {
  EntitySyncStatus,
  Order,
  OrderItem,
  OpStatus,
  OpType,
  PaymentMethod,
  Product,
  StockMovement,
  SyncOperation,
} from '../domain/types';
import type { ShopDatabase } from './database';

export class BusinessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

/** Opérations pouvant encore être traitées (ni terminées, ni annulées). */
const ACTIVE_STATUSES: OpStatus[] = ['pending', 'syncing', 'failed', 'conflict'];
const ORDER_OP_TYPES: OpType[] = ['create_order', 'cancel_order'];

export function nowIso(): string {
  return new Date().toISOString();
}

// -----------------------------------------------------------------------------
// File de synchronisation
// -----------------------------------------------------------------------------

export async function enqueueOperation(
  db: ShopDatabase,
  op: { type: OpType; entity_id: string; payload: Record<string, unknown> },
): Promise<SyncOperation> {
  const now = nowIso();
  const record: SyncOperation = {
    op_id: newId(),
    type: op.type,
    entity_id: op.entity_id,
    payload: op.payload,
    status: 'pending',
    attempts: 0,
    error_code: null,
    last_error: null,
    server_snapshot: null,
    created_at: now,
    updated_at: now,
  };
  record.seq = await db.sync_operations.add(record);
  return record;
}

/**
 * Recalcule l'état de synchronisation d'une entité (article ou commande) à partir de ses opérations.
 * Priorité : conflit > échec > en attente > synchronisé.
 */
export async function recomputeEntitySync(db: ShopDatabase, entityId: string): Promise<void> {
  const all = await db.sync_operations.where('entity_id').equals(entityId).toArray();
  const live = all.filter((o) => o.status !== 'void' && o.status !== 'done');
  let status: EntitySyncStatus = 'synced';
  if (live.some((o) => o.status === 'conflict')) status = 'conflict';
  else if (live.some((o) => o.status === 'failed')) status = 'failed';
  else if (live.some((o) => o.status === 'pending' || o.status === 'syncing')) status = 'pending';

  const product = await db.products.get(entityId);
  if (product) {
    await db.products.update(entityId, { sync_status: status });
    return;
  }
  const order = await db.orders.get(entityId);
  if (order && order.sync_status !== 'void') {
    await db.orders.update(entityId, { sync_status: status });
  }
}

/** Nombre d'opérations non encore confirmées par le serveur. */
export async function countPendingOperations(db: ShopDatabase): Promise<number> {
  return db.sync_operations.where('status').anyOf(['pending', 'syncing', 'failed', 'conflict']).count();
}

// -----------------------------------------------------------------------------
// Articles
// -----------------------------------------------------------------------------

function catalogFields(values: ProductFormValues) {
  return {
    name: values.name.trim(),
    category: values.category?.trim() ? values.category.trim() : null,
    purchase_price: values.purchase_price,
    sale_price: values.sale_price,
    alert_threshold: values.alert_threshold,
  };
}

function assertValid(values: ProductFormValues, mode: 'create' | 'edit'): void {
  const { errors } = validateProduct(values, mode);
  const first = Object.values(errors)[0];
  if (first) throw new BusinessError('validation', first);
}

export async function createProduct(db: ShopDatabase, shopId: string, values: ProductFormValues): Promise<Product> {
  assertValid(values, 'create');
  const id = newId();
  const now = nowIso();
  const fields = catalogFields(values);

  const product: Product = {
    id,
    shop_id: shopId,
    ...fields,
    quantity: values.initial_quantity,
    status: 'active',
    created_at: now,
    updated_at: now,
    archived_at: null,
    version: 0,
    sync_status: 'pending',
  };

  const initialMovementId = values.initial_quantity > 0 ? newId() : null;

  await db.transaction('rw', [db.products, db.stock_movements, db.sync_operations], async () => {
    if (await db.products.get(id)) throw new BusinessError('duplicate', 'Cet article existe déjà.');
    await db.products.add(product);
    if (initialMovementId) {
      await db.stock_movements.add({
        id: initialMovementId,
        shop_id: shopId,
        product_id: id,
        order_id: null,
        type: 'initial',
        quantity_delta: values.initial_quantity,
        quantity_after: values.initial_quantity,
        reason: 'Stock initial',
        created_at: now,
      });
    }
    await enqueueOperation(db, {
      type: 'upsert_product',
      entity_id: id,
      payload: {
        shop_id: shopId,
        product: {
          id,
          ...fields,
          status: 'active',
          base_version: 0,
          initial_quantity: values.initial_quantity,
          initial_movement_id: initialMovementId,
          created_at: now,
          updated_at: now,
        },
      },
    });
  });
  return product;
}

/**
 * Modifie les champs du catalogue. Plusieurs modifications successives d'un article
 * non encore envoyé sont fusionnées dans une seule opération (évite les conflits internes).
 */
export async function updateProduct(
  db: ShopDatabase,
  productId: string,
  values: ProductFormValues,
): Promise<Product> {
  assertValid(values, 'edit');
  const fields = catalogFields(values);
  return applyCatalogChange(db, productId, fields);
}

export async function setProductArchived(db: ShopDatabase, productId: string, archived: boolean): Promise<Product> {
  return applyCatalogChange(db, productId, {}, archived ? 'archived' : 'active');
}

async function applyCatalogChange(
  db: ShopDatabase,
  productId: string,
  fields: Partial<Pick<Product, 'name' | 'category' | 'purchase_price' | 'sale_price' | 'alert_threshold'>>,
  status?: 'active' | 'archived',
): Promise<Product> {
  let updated: Product | null = null;
  await db.transaction('rw', [db.products, db.sync_operations], async () => {
    const product = await db.products.get(productId);
    if (!product) throw new BusinessError('not_found', 'Article introuvable.');

    const ops = (await db.sync_operations.where('entity_id').equals(productId).toArray()).filter(
      (o) => ACTIVE_STATUSES.includes(o.status),
    );
    if (ops.some((o) => o.status === 'syncing')) {
      throw new BusinessError('busy', 'Synchronisation en cours pour cet article. Réessayez dans un instant.');
    }
    if (ops.some((o) => o.status === 'failed' || o.status === 'conflict')) {
      throw new BusinessError(
        'needs_resolution',
        'Cet article a une synchronisation à résoudre. Ouvrez l’article pour la traiter avant de le modifier.',
      );
    }

    const now = nowIso();
    const nextStatus = status ?? product.status;
    const archivedAt = nextStatus === 'archived' ? (product.archived_at ?? now) : null;
    updated = {
      ...product,
      ...fields,
      status: nextStatus,
      archived_at: archivedAt,
      updated_at: now,
      sync_status: 'pending',
    };
    await db.products.put(updated);

    const pending = ops.find((o) => o.type === 'upsert_product' && o.status === 'pending');
    if (pending) {
      const payload = pending.payload as { shop_id: string; product: Record<string, unknown> };
      await db.sync_operations.update(pending.seq!, {
        payload: {
          ...payload,
          product: {
            ...payload.product,
            ...fields,
            status: nextStatus,
            archived_at: archivedAt,
            updated_at: now,
          },
        },
        updated_at: now,
      });
    } else {
      await enqueueOperation(db, {
        type: 'upsert_product',
        entity_id: productId,
        payload: {
          shop_id: product.shop_id,
          product: {
            id: productId,
            name: updated.name,
            category: updated.category,
            purchase_price: updated.purchase_price,
            sale_price: updated.sale_price,
            alert_threshold: updated.alert_threshold,
            status: nextStatus,
            archived_at: archivedAt,
            base_version: product.version,
            created_at: product.created_at,
            updated_at: now,
          },
        },
      });
    }
  });
  if (!updated) throw new BusinessError('not_found', 'Article introuvable.');
  return updated;
}

/** Entrée de stock (réception de marchandises). Quantité strictement positive. */
export async function addStockEntry(
  db: ShopDatabase,
  productId: string,
  quantity: number,
  note?: string,
): Promise<Product> {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new BusinessError('invalid_quantity', 'La quantité doit être un nombre entier supérieur à 0.');
  }
  return applyStockMovement(db, productId, {
    type: 'entry',
    delta: quantity,
    reason: note?.trim() || 'Entrée de stock',
  });
}

/**
 * Correction manuelle du stock (inventaire). Motif obligatoire, stock jamais négatif.
 * delta positif ou négatif, non nul.
 */
export async function adjustStock(
  db: ShopDatabase,
  productId: string,
  delta: number,
  reason: string,
): Promise<Product> {
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new BusinessError('invalid_quantity', 'La correction doit être un nombre entier non nul.');
  }
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new BusinessError('reason_required', 'Indiquez le motif de la correction (3 caractères minimum).');
  }
  return applyStockMovement(db, productId, { type: 'correction', delta, reason: trimmed });
}

async function applyStockMovement(
  db: ShopDatabase,
  productId: string,
  input: { type: 'entry' | 'correction'; delta: number; reason: string },
): Promise<Product> {
  let updated: Product | null = null;
  await db.transaction('rw', [db.products, db.stock_movements, db.sync_operations], async () => {
    const product = await db.products.get(productId);
    if (!product) throw new BusinessError('not_found', 'Article introuvable.');
    if (product.status === 'archived') {
      throw new BusinessError('archived', 'Cet article est archivé. Réactivez-le pour modifier son stock.');
    }
    const ops = (await db.sync_operations.where('entity_id').equals(productId).toArray()).filter(
      (o) => ACTIVE_STATUSES.includes(o.status),
    );
    if (ops.some((o) => o.status === 'failed' || o.status === 'conflict')) {
      throw new BusinessError('needs_resolution', 'Cet article a une synchronisation à résoudre. Traitez-la d’abord.');
    }
    const after = product.quantity + input.delta;
    if (after < 0) {
      throw new BusinessError(
        'insufficient_stock',
        `Stock insuffisant : il reste ${product.quantity} article(s), la correction donnerait un stock négatif.`,
      );
    }
    const now = nowIso();
    const movementId = newId();
    updated = { ...product, quantity: after, updated_at: now, sync_status: 'pending' };
    await db.products.put(updated);
    await db.stock_movements.add({
      id: movementId,
      shop_id: product.shop_id,
      product_id: productId,
      order_id: null,
      type: input.type,
      quantity_delta: input.delta,
      quantity_after: after,
      reason: input.reason,
      created_at: now,
    });
    await enqueueOperation(db, {
      type: 'stock_movement',
      entity_id: productId,
      payload: {
        shop_id: product.shop_id,
        movement: {
          id: movementId,
          product_id: productId,
          type: input.type,
          delta: input.delta,
          reason: input.reason,
          created_at: now,
        },
      },
    });
  });
  if (!updated) throw new BusinessError('not_found', 'Article introuvable.');
  return updated;
}

// -----------------------------------------------------------------------------
// Commandes
// -----------------------------------------------------------------------------

export interface OrderDraftLine {
  product_id: string;
  quantity: number;
}

export interface CreateOrderInput {
  /** Identifiant fixé à l'ouverture du panier : un double clic ne crée donc jamais deux commandes. */
  id: string;
  lines: OrderDraftLine[];
  payment_method: PaymentMethod;
}

export interface CreatedOrder {
  order: Order;
  items: OrderItem[];
}

/**
 * Enregistre une commande localement, de façon atomique :
 * commande + lignes + mouvements de stock + opération de synchronisation.
 * Les prix et coûts sont recopiés depuis le catalogue au moment de la vente.
 */
export async function createOrder(db: ShopDatabase, shopId: string, input: CreateOrderInput): Promise<CreatedOrder> {
  if (input.lines.length === 0) {
    throw new BusinessError('empty_order', 'Ajoutez au moins un article à la commande.');
  }
  if (!validatePaymentMethod(input.payment_method)) {
    throw new BusinessError('invalid_payment', 'Choisissez un mode de paiement.');
  }
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.product_id)) {
      throw new BusinessError('duplicate_line', 'Un même article ne peut apparaître qu’une seule fois dans la commande.');
    }
    seen.add(line.product_id);
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new BusinessError('invalid_quantity', 'Les quantités doivent être des nombres entiers supérieurs à 0.');
    }
  }

  let result: CreatedOrder | null = null;
  await db.transaction('rw', [db.products, db.orders, db.order_items, db.stock_movements, db.sync_operations], async () => {
    if (await db.orders.get(input.id)) {
      throw new BusinessError('duplicate_order', 'Cette commande a déjà été enregistrée.');
    }

    const priced: { product: Product; line: OrderDraftLine; name: string }[] = [];
    for (const line of input.lines) {
      const product = await db.products.get(line.product_id);
      if (!product || product.shop_id !== shopId) {
        throw new BusinessError('not_found', 'Un article de la commande n’existe plus.');
      }
      if (product.status === 'archived') {
        throw new BusinessError('archived', `« ${product.name} » est archivé et ne peut plus être vendu.`);
      }
      if (product.quantity < line.quantity) {
        throw new BusinessError(
          'insufficient_stock',
          `Stock insuffisant pour « ${product.name} » : ${product.quantity} disponible(s), ${line.quantity} demandé(s).`,
        );
      }
      priced.push({ product, line, name: product.name });
    }

    const pricedLines: PricedLine[] = priced.map(({ product, line }) => ({
      quantity: line.quantity,
      unit_price: product.sale_price,
      unit_cost: product.purchase_price,
    }));
    const totals = orderTotals(pricedLines);
    const now = nowIso();

    const order: Order = {
      id: input.id,
      shop_id: shopId,
      created_at: now,
      status: 'confirmed',
      payment_method: input.payment_method,
      total_amount: totals.total_amount,
      total_cost: totals.total_cost,
      gross_margin: totals.gross_margin,
      total_quantity: totals.total_quantity,
      cancelled_at: null,
      cancel_reason: null,
      updated_at: now,
      sync_status: 'pending',
    };

    const items: OrderItem[] = [];
    const wireItems: Record<string, unknown>[] = [];
    const movements: StockMovement[] = [];

    for (const { product, line, name } of priced) {
      const after = product.quantity - line.quantity;
      await db.products.update(product.id, { quantity: after });
      const item: OrderItem = {
        id: newId(),
        order_id: order.id,
        product_id: product.id,
        product_name: name,
        unit_price: product.sale_price,
        unit_cost: product.purchase_price,
        quantity: line.quantity,
        line_total: multiplyAmount(product.sale_price, line.quantity),
        line_cost: multiplyAmount(product.purchase_price, line.quantity),
      };
      items.push(item);
      const movementId = newId();
      movements.push({
        id: movementId,
        shop_id: shopId,
        product_id: product.id,
        order_id: order.id,
        type: 'sale',
        quantity_delta: -line.quantity,
        quantity_after: after,
        reason: 'Vente',
        created_at: now,
      });
      wireItems.push({
        id: item.id,
        product_id: product.id,
        product_name: name,
        unit_price: product.sale_price,
        unit_cost: product.purchase_price,
        quantity: line.quantity,
        movement_id: movementId,
      });
    }

    await db.orders.add(order);
    await db.order_items.bulkAdd(items);
    await db.stock_movements.bulkAdd(movements);
    await enqueueOperation(db, {
      type: 'create_order',
      entity_id: order.id,
      payload: {
        shop_id: shopId,
        order: {
          id: order.id,
          created_at: now,
          payment_method: order.payment_method,
          total_amount: order.total_amount,
          total_cost: order.total_cost,
          total_quantity: order.total_quantity,
        },
        items: wireItems,
      },
    });

    result = { order, items };
  });
  if (!result) throw new BusinessError('unknown', 'La commande n’a pas pu être enregistrée.');
  return result;
}

/**
 * Annule une commande confirmée : la commande reste consultable (statut « annulée »),
 * et le stock est restauré par des mouvements « cancel_restock » traçables.
 */
export async function cancelOrder(db: ShopDatabase, orderId: string, reason: string): Promise<Order> {
  const reasonError = validateReason(reason);
  if (reasonError) throw new BusinessError('reason_required', reasonError);
  const cleanReason = reason.trim();

  let updated: Order | null = null;
  await db.transaction('rw', [db.products, db.orders, db.order_items, db.stock_movements, db.sync_operations], async () => {
    const order = await db.orders.get(orderId);
    if (!order) throw new BusinessError('not_found', 'Commande introuvable.');
    if (order.status === 'cancelled') throw new BusinessError('already_cancelled', 'Cette commande est déjà annulée.');

    const ops = await db.sync_operations.where('entity_id').equals(orderId).toArray();
    const createOp = ops.find((o) => o.type === 'create_order' && o.status !== 'void');
    if (createOp?.status === 'syncing') {
      throw new BusinessError('busy', 'Synchronisation de cette commande en cours. Réessayez dans un instant.');
    }

    const items = await db.order_items.where('order_id').equals(orderId).toArray();
    const now = nowIso();
    const movements: StockMovement[] = [];
    for (const item of items) {
      const product = await db.products.get(item.product_id);
      if (!product) continue;
      const after = product.quantity + item.quantity;
      await db.products.update(product.id, { quantity: after, updated_at: now });
      movements.push({
        id: newId(),
        shop_id: order.shop_id,
        product_id: product.id,
        order_id: orderId,
        type: 'cancel_restock',
        quantity_delta: item.quantity,
        quantity_after: after,
        reason: `Annulation : ${cleanReason}`,
        created_at: now,
      });
    }
    await db.stock_movements.bulkAdd(movements);

    updated = {
      ...order,
      status: 'cancelled',
      cancelled_at: now,
      cancel_reason: cleanReason,
      updated_at: now,
      sync_status: 'pending',
    };
    await db.orders.put(updated);

    // Toujours envoyée : la file est ordonnée, donc elle suit la création si elle est encore en attente.
    // (Une commande importée d'un autre appareil n'a pas d'opération de création locale.)
    await enqueueOperation(db, {
      type: 'cancel_order',
      entity_id: orderId,
      payload: {
        shop_id: order.shop_id,
        order_id: orderId,
        cancelled_at: now,
        reason: cleanReason,
      },
    });
  });
  if (!updated) throw new BusinessError('not_found', 'Commande introuvable.');
  return updated;
}

// -----------------------------------------------------------------------------
// Résolution des erreurs de synchronisation (action explicite de l'utilisateur)
// -----------------------------------------------------------------------------

export type ResolutionAction = 'retry' | 'discard' | 'keep_local' | 'use_server';

/**
 * Applique une action de résolution sur une opération en échec ou en conflit.
 * - retry : renvoyer l'opération.
 * - discard : abandonner l'opération SUR CET APPAREIL uniquement, en annulant ses effets locaux.
 * - keep_local : conflit de version -> garder la version de cet appareil.
 * - use_server : conflit de version -> prendre la version du serveur (les modifications locales non envoyées sont perdues, après confirmation).
 */
export async function resolveOperation(db: ShopDatabase, opSeq: number, action: ResolutionAction): Promise<void> {
  await db.transaction(
    'rw',
    [db.products, db.orders, db.order_items, db.stock_movements, db.sync_operations],
    async () => {
      const op = await db.sync_operations.get(opSeq);
      if (!op) throw new BusinessError('not_found', 'Opération introuvable.');
      if (op.status !== 'failed' && op.status !== 'conflict') {
        throw new BusinessError('invalid_state', 'Cette opération ne demande pas d’action.');
      }
      const now = nowIso();

      if (action === 'retry') {
        await db.sync_operations.update(opSeq, { status: 'pending', error_code: null, last_error: null, updated_at: now });
        await recomputeEntitySync(db, op.entity_id);
        return;
      }

      if (action === 'keep_local') {
        if (op.type !== 'upsert_product' || op.status !== 'conflict') {
          throw new BusinessError('invalid_state', 'Cette action ne s’applique qu’à un conflit d’article.');
        }
        const serverVersion = Number((op.server_snapshot as { server_version?: number } | null)?.server_version);
        if (!Number.isSafeInteger(serverVersion)) {
          throw new BusinessError('invalid_state', 'Version serveur inconnue. Réessayez la synchronisation.');
        }
        const payload = op.payload as { shop_id: string; product: Record<string, unknown> };
        await db.sync_operations.update(opSeq, {
          payload: { ...payload, product: { ...payload.product, base_version: serverVersion } },
          status: 'pending',
          error_code: null,
          last_error: null,
          server_snapshot: null,
          updated_at: now,
        });
        await recomputeEntitySync(db, op.entity_id);
        return;
      }

      if (action === 'use_server') {
        if (op.type !== 'upsert_product' || op.status !== 'conflict') {
          throw new BusinessError('invalid_state', 'Cette action ne s’applique qu’à un conflit d’article.');
        }
        const snap = op.server_snapshot as
          | { server_version?: number; server_product?: Record<string, unknown> }
          | null;
        const sp = snap?.server_product;
        if (!sp || typeof sp.version !== 'number') {
          throw new BusinessError('invalid_state', 'Données serveur indisponibles. Réessayez la synchronisation.');
        }
        await db.sync_operations.update(opSeq, { status: 'void', updated_at: now });
        await db.products.update(op.entity_id, {
          name: String(sp.name),
          category: (sp.category as string | null) ?? null,
          purchase_price: Number(sp.purchase_price),
          sale_price: Number(sp.sale_price),
          alert_threshold: Number(sp.alert_threshold),
          status: sp.status as Product['status'],
          archived_at: sp.status === 'archived' ? now : null,
          version: Number(sp.version),
          updated_at: now,
        });
        await recomputeEntitySync(db, op.entity_id);
        return;
      }

      // discard : annuler les effets locaux de l'opération non envoyée.
      if (op.type === 'create_order') {
        await discardOrderOperations(db, op.entity_id, now);
        return;
      }
      if (op.type === 'stock_movement') {
        const movement = (op.payload as { movement: { id: string; delta: number } }).movement;
        const product = await db.products.get(op.entity_id);
        if (product) {
          await db.products.update(op.entity_id, {
            quantity: product.quantity - movement.delta,
            updated_at: now,
          });
        }
        await db.stock_movements.delete(movement.id);
        await db.sync_operations.update(opSeq, { status: 'void', updated_at: now });
        await recomputeEntitySync(db, op.entity_id);
        return;
      }
      throw new BusinessError('invalid_state', 'Cette opération ne peut pas être abandonnée. Réessayez-la.');
    },
  );
}

/**
 * Abandonne la création d'une commande jamais enregistrée sur le serveur :
 * annule l'opération et ses suites, restaure le stock local et marque la commande « non envoyée ».
 */
async function discardOrderOperations(db: ShopDatabase, orderId: string, now: string): Promise<void> {
  const ops = await db.sync_operations.where('entity_id').equals(orderId).toArray();
  for (const op of ops) {
    if (op.status !== 'done' && op.status !== 'void' && op.status !== 'syncing') {
      await db.sync_operations.update(op.seq!, { status: 'void', updated_at: now });
    }
  }
  const order = await db.orders.get(orderId);
  if (!order) return;
  if (order.status === 'confirmed') {
    const items = await db.order_items.where('order_id').equals(orderId).toArray();
    const movements: StockMovement[] = [];
    for (const item of items) {
      const product = await db.products.get(item.product_id);
      if (!product) continue;
      const after = product.quantity + item.quantity;
      await db.products.update(product.id, { quantity: after, updated_at: now });
      movements.push({
        id: newId(),
        shop_id: order.shop_id,
        product_id: product.id,
        order_id: orderId,
        type: 'cancel_restock',
        quantity_delta: item.quantity,
        quantity_after: after,
        reason: 'Annulation locale : commande non enregistrée sur le serveur',
        created_at: now,
      });
    }
    await db.stock_movements.bulkAdd(movements);
  }
  await db.orders.update(orderId, {
    status: 'cancelled',
    cancelled_at: order.cancelled_at ?? now,
    cancel_reason: 'Non enregistrée sur le serveur (abandonnée sur cet appareil)',
    updated_at: now,
    sync_status: 'void',
  });
}

/** Renommage de la boutique : modification locale + opération de synchronisation. */
export async function updateShopName(db: ShopDatabase, shopId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (clean.length === 0 || clean.length > 120) {
    throw new BusinessError('validation', 'Le nom de la boutique doit contenir entre 1 et 120 caractères.');
  }
  await db.transaction('rw', [db.meta, db.sync_operations], async () => {
    await db.meta.put({ key: 'shop', value: { id: shopId, name: clean } });
    await enqueueOperation(db, { type: 'update_shop', entity_id: shopId, payload: { shop_id: shopId, name: clean } });
  });
}

export function operationLabel(type: OpType): string {
  switch (type) {
    case 'create_order':
      return 'Enregistrement d’une commande';
    case 'cancel_order':
      return 'Annulation d’une commande';
    case 'upsert_product':
      return 'Modification d’un article';
    case 'stock_movement':
      return 'Mouvement de stock';
    case 'update_shop':
      return 'Nom de la boutique';
  }
}

export function isOrderOp(type: OpType): boolean {
  return ORDER_OP_TYPES.includes(type);
}
