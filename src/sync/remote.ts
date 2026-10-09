/**
 * Adaptateur distant : parle à l'API ShopFlow (Express) qui détient la base Neon.
 * Le moteur de synchronisation ne dépend que de l'interface RemoteAdapter, ce qui permet de
 * le tester avec une vraie base PostgreSQL (PGlite) et un vrai serveur HTTP en local.
 */
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

export interface ApiClientOptions {
  /** Fournit le jeton Neon Auth (JWT) de la session courante, ou null si déconnecté. */
  getToken: () => Promise<string | null>;
  /** Préfixe des routes (vide = même origine). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const SESSION_EXPIRED = 'Session expirée : reconnectez-vous pour synchroniser.';
const SERVER_UNAVAILABLE = 'Serveur indisponible. Vos données restent enregistrées sur cet appareil.';

/** Corps d'erreur renvoyé par l'API : { error, code?, message? }. */
async function readErrorBody(res: Response): Promise<{ error?: string; code?: string; message?: string }> {
  try {
    return (await res.json()) as { error?: string; code?: string; message?: string };
  } catch {
    return {};
  }
}

/**
 * Appel JSON authentifié. Règles de classement :
 *  - réseau coupé, délai, 401 (session expirée), 503 et autres 5xx -> TransportError (opération en attente)
 *  - 400 / 403 / 422 (refus métier ou erreur SQL) -> ServerError avec le code (opération en échec)
 */
export function createApiClient({ getToken, baseUrl = '', fetchImpl = fetch }: ApiClientOptions) {
  return async function post<T>(path: string, body: unknown): Promise<T> {
    let token: string | null;
    try {
      token = await getToken();
    } catch {
      // Échec de l'obtention du jeton (souvent hors ligne) : l'opération reste en attente.
      throw new TransportError();
    }
    if (!token) throw new TransportError(SESSION_EXPIRED);

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TransportError();
    }

    if (res.status === 401) throw new TransportError(SESSION_EXPIRED);
    if (res.status === 403) {
      throw new ServerError('forbidden_shop', 'Accès refusé à cette boutique.');
    }
    if (res.status === 400 || res.status === 422) {
      const err = await readErrorBody(res);
      const code = err.code ?? err.error ?? 'invalid_request';
      throw new ServerError(code, err.message || 'Erreur serveur');
    }
    if (!res.ok) throw new TransportError(SERVER_UNAVAILABLE);

    try {
      return (await res.json()) as T;
    } catch {
      throw new TransportError(SERVER_UNAVAILABLE);
    }
  };
}

export interface EnsureShopResult {
  id: string;
  name: string;
  created: boolean;
}

/** Adaptateur distant complet (sync + création de boutique). */
export function createHttpRemote(options: ApiClientOptions): RemoteAdapter & { ensureShop(name: string | null): Promise<EnsureShopResult> } {
  const post = createApiClient(options);
  return {
    ensureShop(name: string | null) {
      return post<EnsureShopResult>('/api/shop/ensure', { name: name ?? '' });
    },

    apply(op) {
      return post<RemoteResult>('/api/sync/apply', { op_id: op.op_id, type: op.type, payload: op.payload });
    },

    pull(shopId) {
      return post<RemoteSnapshot>('/api/sync/pull', { shop_id: shopId });
    },
  };
}
