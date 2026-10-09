/**
 * Adaptateur distant (Supabase). Le moteur de synchronisation ne dépend que de l'interface
 * RemoteAdapter, ce qui permet de le tester avec une vraie base PostgreSQL (PGlite) en local.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OpType } from '../domain/types';

export interface RemoteResult {
  status: 'applied' | 'already_applied' | 'failed' | 'conflict';
  code?: string;
  duplicate?: boolean;
  [key: string]: unknown;
}

export interface RemoteProductRow {
  id: string;
  shop_id: string;
  name: string;
  category: string | null;
  purchase_price: number;
  sale_price: number;
  quantity: number;
  alert_threshold: number;
  status: 'active' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface RemoteItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  unit_cost: number;
  quantity: number;
}

export interface RemoteOrderRow {
  id: string;
  shop_id: string;
  status: 'confirmed' | 'cancelled';
  payment_method: 'cash' | 'mobile_money' | 'other';
  total_amount: number;
  total_cost: number;
  total_quantity: number;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  updated_at: string;
  order_items?: RemoteItemRow[];
}

export interface RemoteMovementRow {
  id: string;
  shop_id: string;
  product_id: string;
  order_id: string | null;
  type: 'initial' | 'entry' | 'sale' | 'cancel_restock' | 'correction';
  quantity_delta: number;
  quantity_after: number;
  reason: string | null;
  created_at: string;
}

export interface RemoteSnapshot {
  shop: { id: string; name: string } | null;
  products: RemoteProductRow[];
  orders: RemoteOrderRow[];
  movements: RemoteMovementRow[];
}

export interface RemoteAdapter {
  apply(op: { op_id: string; type: OpType; payload: Record<string, unknown> }): Promise<RemoteResult>;
  pull(shopId: string): Promise<RemoteSnapshot>;
}

/** Échec de transport (hors ligne, réseau coupé, délai dépassé) : l'opération reste en attente. */
export class TransportError extends Error {
  constructor(message = 'Connexion impossible. Vos données restent enregistrées sur cet appareil.') {
    super(message);
    this.name = 'TransportError';
  }
}

/** Erreur renvoyée par le serveur (base, règle de sécurité) : l'opération est marquée en échec. */
export class ServerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
  }
}

/** Classe une erreur PostgREST / supabase-js. Les codes SQLSTATE sont à 5 caractères. */
export function classifyRemoteError(error: { code?: string; message?: string } | null | undefined): Error {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  // SQLSTATE (5 caractères, ex. 42501) ou code PostgREST (ex. PGRST301 : session expirée).
  if (/^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code)) {
    return new ServerError(code, message || 'Erreur serveur');
  }
  return new TransportError();
}

const PAGE = 500;

export function createSupabaseRemote(client: SupabaseClient): RemoteAdapter {
  async function fetchAll<T>(table: string, select: string, shopId: string): Promise<T[]> {
    const rows: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from(table)
        .select(select)
        .eq('shop_id', shopId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw classifyRemoteError(error);
      rows.push(...((data as T[]) ?? []));
      if (!data || data.length < PAGE) break;
    }
    return rows;
  }

  return {
    async apply(op) {
      const { data, error } = await client.rpc('apply_sync_operation', {
        p_op_id: op.op_id,
        p_op_type: op.type,
        p_payload: op.payload,
      });
      if (error) throw classifyRemoteError(error);
      return data as RemoteResult;
    },

    async pull(shopId) {
      const { data: shopRow, error: shopError } = await client
        .from('shops')
        .select('id, name')
        .eq('id', shopId)
        .maybeSingle();
      if (shopError) throw classifyRemoteError(shopError);

      const [products, orders, movements] = await Promise.all([
        fetchAll<RemoteProductRow>('products', '*', shopId),
        fetchAll<RemoteOrderRow>('orders', '*, order_items(*)', shopId),
        fetchAll<RemoteMovementRow>('stock_movements', '*', shopId),
      ]);

      return {
        shop: shopRow ? { id: shopRow.id as string, name: shopRow.name as string } : null,
        products,
        orders,
        movements,
      };
    },
  };
}
