/**
 * Moteur de synchronisation (file d'opérations locale -> serveur, puis serveur -> local).
 *
 * Règles (documentées dans docs/ARCHITECTURE.md) :
 *  1. Une opération n'est retirée/marquée « terminée » QUE après la réponse explicite du serveur.
 *  2. Les opérations sont envoyées dans l'ordre (FIFO). Le serveur est idempotent (op_id).
 *  3. Erreur de transport (hors ligne) : l'opération reste « en attente », on arrête le cycle.
 *  4. Refus métier (stock insuffisant, conflit de version, article introuvable) : l'opération
 *     passe en « échec » ou « conflit », rien n'est écrit côté serveur, et les opérations qui
 *     dépendent de la même entité sont suspendues (les autres continuent).
 *  5. Le téléchargement ne remplace jamais une donnée ayant une opération non terminée.
 *  6. Une opération « syncing » trouvée au démarrage est remise en « pending » (sûr grâce à l'idempotence).
 */
import type { ShopDatabase } from '../db/database';
import { recomputeEntitySync } from '../db/repo';
import type { EntitySyncStatus, Order, OrderItem, Product, StockMovement, SyncOperation } from '../domain/types';
import { ServerError, TransportError, type RemoteAdapter, type RemoteOrderRow, type RemoteProductRow, type RemoteSnapshot } from './remote';

export interface SyncReport {
  outcome: 'synced' | 'partial' | 'offline' | 'error' | 'skipped';
  pushed: number;
  waiting: number;
  needsAttention: number;
  pulled: boolean;
  message: string;
  finishedAt: string;
}

const FAILURE_MESSAGES: Record<string, string> = {
  insufficient_stock: 'Stock insuffisant sur le serveur : un autre appareil a probablement vendu le même article.',
  product_not_found: 'Article introuvable sur le serveur.',
  order_not_found: 'Commande introuvable sur le serveur.',
  invalid_quantity: 'Quantité invalide.',
  invalid_price: 'Prix invalide.',
  invalid_payment_method: 'Mode de paiement invalide.',
  empty_order: 'La commande ne contient aucun article.',
  duplicate_product_line: 'Un article apparaît deux fois dans la commande.',
  reason_required: 'Le motif est obligatoire.',
  invalid_movement_type: 'Type de mouvement non reconnu.',
  invalid_status: 'Statut d’article invalide.',
  invalid_payload: 'Données de l’opération invalides.',
  forbidden: 'Accès refusé à cet article.',
  shop_name_invalid: 'Nom de boutique invalide.',
  version_conflict: 'Cet article a été modifié depuis un autre appareil.',
};

export function failureMessage(code: string | null, fallback?: string): string {
  if (code && FAILURE_MESSAGES[code]) return FAILURE_MESSAGES[code];
  return fallback || 'La synchronisation a échoué pour une raison inconnue.';
}

/** Entités dont dépend une opération : l'entité elle-même, et pour une commande, ses articles. */
export function dependencyIds(op: Pick<SyncOperation, 'type' | 'entity_id' | 'payload'>): string[] {
  const deps = [op.entity_id];
  if (op.type === 'create_order') {
    const items = (op.payload.items as { product_id: string }[] | undefined) ?? [];
    for (const it of items) deps.push(it.product_id);
  }
  return deps;
}

export interface EngineContext {
  db: ShopDatabase;
  remote: RemoteAdapter;
  shopId: string;
  now?: () => string;
}

/** Exécute un cycle complet : envoi de la file, puis téléchargement. */
export async function runSync(ctx: EngineContext): Promise<SyncReport> {
  const { db, remote, shopId } = ctx;
  const now = ctx.now ?? (() => new Date().toISOString());
  const report: SyncReport = {
    outcome: 'synced',
    pushed: 0,
    waiting: 0,
    needsAttention: 0,
    pulled: false,
    message: '',
    finishedAt: now(),
  };

  // Règle 6 : une opération restée « syncing » après un arrêt brutal est renvoyée.
  await db.sync_operations.where('status').equals('syncing').modify({ status: 'pending', updated_at: now() });

  // Entités bloquées : celles qui ont déjà un échec ou un conflit à résoudre.
  const blocked = new Set<string>();
  const attention = await db.sync_operations.where('status').anyOf(['failed', 'conflict']).toArray();
  for (const op of attention) for (const id of dependencyIds(op)) blocked.add(id);

  let transportDown = false;
  const pending = await db.sync_operations.where('status').equals('pending').sortBy('seq');

  for (const op of pending) {
    if (dependencyIds(op).some((id) => blocked.has(id))) {
      report.waiting += 1;
      blocked.add(op.entity_id);
      continue;
    }

    await db.sync_operations.update(op.seq!, { status: 'syncing', updated_at: now() });
    try {
      const result = await remote.apply({ op_id: op.op_id, type: op.type, payload: op.payload });
      await applyResult(db, op, result, now());
      if (result.status === 'applied' || result.status === 'already_applied') {
        report.pushed += 1;
      } else {
        for (const id of dependencyIds(op)) blocked.add(id);
      }
    } catch (error) {
      if (error instanceof TransportError || !(error instanceof ServerError)) {
        // Hors ligne ou réseau coupé : on remet l'opération en attente et on arrête le cycle.
        await db.sync_operations.update(op.seq!, {
          status: 'pending',
          attempts: op.attempts + 1,
          last_error: 'Connexion impossible. Enregistré sur cet appareil.',
          updated_at: now(),
        });
        transportDown = true;
        break;
      }
      await db.sync_operations.update(op.seq!, {
        status: 'failed',
        attempts: op.attempts + 1,
        error_code: 'server_error',
        last_error: `Erreur du serveur : ${error.message}`,
        updated_at: now(),
      });
      await recomputeEntitySync(db, op.entity_id);
      for (const id of dependencyIds(op)) blocked.add(id);
    }
  }

  const remaining = await db.sync_operations.where('status').anyOf(['pending', 'syncing', 'failed', 'conflict']).toArray();
  report.needsAttention = remaining.filter((o) => o.status === 'failed' || o.status === 'conflict').length;
  report.waiting = Math.max(report.waiting, remaining.filter((o) => o.status === 'pending').length);

  if (transportDown) {
    report.outcome = 'offline';
    report.message = 'Hors ligne : vos opérations sont enregistrées sur cet appareil et seront envoyées au retour de la connexion.';
    report.finishedAt = now();
    return report;
  }

  // Téléchargement : uniquement si l'envoi s'est terminé sans coupure.
  try {
    const snapshot = await remote.pull(shopId);
    await mergeSnapshot(db, snapshot, shopId, now());
    report.pulled = true;
  } catch (error) {
    report.outcome = error instanceof TransportError ? 'offline' : 'error';
    report.message =
      error instanceof TransportError
        ? 'Hors ligne : envoi partiel. Le téléchargement sera refait au retour de la connexion.'
        : `Le téléchargement a échoué : ${(error as Error).message}`;
    report.finishedAt = now();
    return report;
  }

  if (report.needsAttention > 0) {
    report.outcome = 'partial';
    report.message = `${report.needsAttention} opération(s) demandent votre attention. Ouvrez Paramètres > Synchronisation.`;
  } else if (report.waiting > 0) {
    report.outcome = 'partial';
    report.message = `${report.waiting} opération(s) attendent la résolution d’une opération précédente.`;
  } else {
    report.outcome = 'synced';
    report.message = report.pushed > 0 ? 'Synchronisation réussie.' : 'Tout est à jour.';
  }
  report.finishedAt = now();
  return report;
}

/** Applique la réponse serveur à une opération (dans une transaction locale). */
async function applyResult(
  db: ShopDatabase,
  op: SyncOperation,
  result: { status: string; code?: string; [k: string]: unknown },
  at: string,
): Promise<void> {
  await db.transaction('rw', [db.products, db.orders, db.sync_operations], async () => {
    if (result.status === 'applied' || result.status === 'already_applied') {
      await db.sync_operations.update(op.seq!, { status: 'done', error_code: null, last_error: null, updated_at: at });
      if (op.type === 'upsert_product' && typeof result.version === 'number') {
        await db.products.update(op.entity_id, { version: result.version });
      }
      if (op.type === 'create_order' && typeof result.total_amount === 'number') {
        // Le serveur recalcule les totaux : on aligne l'affichage local sur sa valeur.
        await db.orders.update(op.entity_id, {
          total_amount: result.total_amount as number,
          total_cost: result.total_cost as number,
          gross_margin: result.gross_margin as number,
          total_quantity: result.total_quantity as number,
        });
      }
      await recomputeEntitySync(db, op.entity_id);
      return;
    }

    if (result.status === 'conflict') {
      await db.sync_operations.update(op.seq!, {
        status: 'conflict',
        attempts: op.attempts + 1,
        error_code: 'version_conflict',
        last_error: failureMessage('version_conflict'),
        server_snapshot: result,
        updated_at: at,
      });
      await recomputeEntitySync(db, op.entity_id);
      return;
    }

    // status === 'failed' (refus métier, rien n'a été écrit côté serveur)
    const code = typeof result.code === 'string' ? result.code : 'unknown';
    await db.sync_operations.update(op.seq!, {
      status: 'failed',
      attempts: op.attempts + 1,
      error_code: code,
      last_error: failureMessage(code),
      server_snapshot: result,
      updated_at: at,
    });
    await recomputeEntitySync(db, op.entity_id);
  });
}

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/**
 * Fusionne l'état distant dans la base locale.
 * Une donnée qui a une opération non terminée n'est jamais écrasée (règle 5).
 */
export async function mergeSnapshot(
  db: ShopDatabase,
  snap: RemoteSnapshot,
  shopId: string,
  at: string,
): Promise<void> {
  await db.transaction('rw', [db.products, db.orders, db.order_items, db.stock_movements, db.sync_operations, db.meta], async () => {
    const activeOps = await db.sync_operations.where('status').anyOf(['pending', 'syncing', 'failed', 'conflict']).toArray();
    const busyEntities = new Set(activeOps.flatMap((o) => dependencyIds(o)));

    if (snap.shop) {
      const hasPendingName = activeOps.some((o) => o.type === 'update_shop');
      const current = (await db.meta.get('shop'))?.value as { id: string; name: string } | undefined;
      if (!hasPendingName) {
        await db.meta.put({ key: 'shop', value: { id: shopId, name: snap.shop.name } });
      } else if (!current) {
        await db.meta.put({ key: 'shop', value: { id: shopId, name: snap.shop.name } });
      }
    }

    for (const row of snap.products) {
      if (busyEntities.has(row.id)) continue;
      await db.products.put(mapProduct(row, at));
    }

    const localMovements = await db.stock_movements.toArray();
    const movementIds = new Set(localMovements.map((m) => m.id));
    const compoundKeys = new Set(
      localMovements.filter((m) => m.order_id).map((m) => `${m.order_id}|${m.product_id}|${m.type}`),
    );

    for (const row of snap.orders) {
      const local = await db.orders.get(row.id);
      if (!local) {
        const order = mapOrder(row, at);
        await db.orders.add(order);
        const items: OrderItem[] = (row.order_items ?? []).map((i) => ({
          id: i.id,
          order_id: row.id,
          product_id: i.product_id,
          product_name: i.product_name,
          unit_price: i.unit_price,
          unit_cost: i.unit_cost,
          quantity: i.quantity,
          line_total: i.unit_price * i.quantity,
          line_cost: i.unit_cost * i.quantity,
        }));
        await db.order_items.bulkPut(items);
        continue;
      }
      if (busyEntities.has(row.id)) continue;
      if (local.status !== row.status) {
        await db.orders.put({
          ...local,
          status: row.status,
          cancelled_at: iso(row.cancelled_at),
          cancel_reason: row.cancel_reason,
          updated_at: iso(row.updated_at) ?? at,
          sync_status: 'synced' as EntitySyncStatus,
        });
      }
    }

    const newMovements: StockMovement[] = [];
    for (const m of snap.movements) {
      const key = m.order_id ? `${m.order_id}|${m.product_id}|${m.type}` : null;
      if (movementIds.has(m.id) || (key && compoundKeys.has(key))) continue;
      newMovements.push({
        id: m.id,
        shop_id: m.shop_id,
        product_id: m.product_id,
        order_id: m.order_id,
        type: m.type,
        quantity_delta: m.quantity_delta,
        quantity_after: m.quantity_after,
        reason: m.reason,
        created_at: iso(m.created_at) ?? at,
      });
      movementIds.add(m.id);
      if (key) compoundKeys.add(key);
    }
    if (newMovements.length > 0) await db.stock_movements.bulkAdd(newMovements);
  });
}

function mapProduct(row: RemoteProductRow, at: string): Product {
  return {
    id: row.id,
    shop_id: row.shop_id,
    name: row.name,
    category: row.category,
    purchase_price: Number(row.purchase_price),
    sale_price: Number(row.sale_price),
    quantity: Number(row.quantity),
    alert_threshold: Number(row.alert_threshold),
    status: row.status,
    created_at: iso(row.created_at) ?? at,
    updated_at: iso(row.updated_at) ?? at,
    archived_at: iso(row.archived_at),
    version: Number(row.version),
    sync_status: 'synced',
  };
}

function mapOrder(row: RemoteOrderRow, at: string): Order {
  return {
    id: row.id,
    shop_id: row.shop_id,
    created_at: iso(row.created_at) ?? at,
    status: row.status,
    payment_method: row.payment_method,
    total_amount: Number(row.total_amount),
    total_cost: Number(row.total_cost),
    gross_margin: Number(row.total_amount) - Number(row.total_cost),
    total_quantity: Number(row.total_quantity),
    cancelled_at: iso(row.cancelled_at),
    cancel_reason: row.cancel_reason,
    updated_at: iso(row.updated_at) ?? at,
    sync_status: 'synced',
  };
}

