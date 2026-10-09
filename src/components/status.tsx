/** Libellés et badges d'état (synchronisation, commande, stock). */
import { Badge, type Tone } from './ui';
import type { EntitySyncStatus, OrderStatus, Product } from '../domain/types';
import { isLowStock } from '../lib/calc';

const SYNC: Record<EntitySyncStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Enregistré · en attente d’envoi', tone: 'warning' },
  synced: { label: 'Synchronisé', tone: 'success' },
  failed: { label: 'Échec de synchronisation', tone: 'danger' },
  conflict: { label: 'Conflit à résoudre', tone: 'danger' },
  void: { label: 'Non envoyé (abandonné)', tone: 'neutral' },
};

export function SyncBadge({ status }: { status: EntitySyncStatus }) {
  const s = SYNC[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return status === 'confirmed' ? <Badge tone="success">Confirmée</Badge> : <Badge tone="danger">Annulée</Badge>;
}

export function StockBadge({ product }: { product: Pick<Product, 'quantity' | 'alert_threshold' | 'status' | 'purchase_price'> }) {
  if (product.status === 'archived') return <Badge tone="neutral">Archivé</Badge>;
  if (product.quantity <= 0) return <Badge tone="danger">Rupture</Badge>;
  if (isLowStock(product)) return <Badge tone="warning">Stock faible</Badge>;
  return <Badge tone="brand">En stock</Badge>;
}
