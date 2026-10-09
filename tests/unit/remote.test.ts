import { describe, expect, it, vi } from 'vitest';
import { createApiClient, createHttpRemote, ServerError, TransportError } from '../../src/sync/remote';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const op = { op_id: '6f1c2b7e-0d7a-4c55-9a52-3b9e1f2a4d10', type: 'stock_movement' as const, payload: { shop_id: 's' } };

describe('client HTTP : classement des réponses', () => {
  it('réseau coupé (fetch rejeté) : erreur de transport, l’opération reste en attente', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const remote = createHttpRemote({ getToken: async () => 'jeton', fetchImpl });
    await expect(remote.apply(op)).rejects.toBeInstanceOf(TransportError);
  });

  it('401 (jeton refusé ou expiré) : erreur de transport avec un message de session expirée', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
    const remote = createHttpRemote({ getToken: async () => 'jeton', fetchImpl });
    const err = await remote.pull('s').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as Error).message).toMatch(/Session expirée/);
  });

  it('422 (erreur SQL) : erreur serveur avec le code SQLSTATE (l’opération passe en échec)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(422, { error: 'sql_error', code: '42501', message: 'forbidden_shop' }));
    const remote = createHttpRemote({ getToken: async () => 'jeton', fetchImpl });
    const err = await remote.apply(op).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).code).toBe('42501');
  });

  it('403 (boutique non autorisée) : erreur serveur forbidden_shop', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden_shop' }));
    const remote = createHttpRemote({ getToken: async () => 'jeton', fetchImpl });
    const err = await remote.pull('s').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).code).toBe('forbidden_shop');
  });

  it('503 et autres 5xx : erreur de transport (on réessaiera plus tard)', async () => {
    for (const status of [500, 502, 503]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status, { error: 'x' }));
      const remote = createHttpRemote({ getToken: async () => 'jeton', fetchImpl });
      await expect(remote.apply(op)).rejects.toBeInstanceOf(TransportError);
    }
  });

  it('réponse 200 avec un corps illisible : erreur de transport', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('pas du json', { status: 200 }));
    const remote = createHttpRemote({ getToken: async () => 'jeton', fetchImpl });
    await expect(remote.pull('s')).rejects.toBeInstanceOf(TransportError);
  });
});

describe('client HTTP : requêtes envoyées', () => {
  it('envoie le jeton en Bearer, le corps JSON et renvoie le résultat tel quel', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'applied', version: 2 }));
    const remote = createHttpRemote({ baseUrl: 'https://app.example', getToken: async () => 'abc.def.ghi', fetchImpl });
    const result = await remote.apply(op);
    expect(result).toEqual({ status: 'applied', version: 2 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.example/api/sync/apply');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc.def.ghi');
    expect(JSON.parse(String(init.body))).toEqual({ op_id: op.op_id, type: 'stock_movement', payload: op.payload });
  });

  it('sans jeton : aucune requête n’est envoyée', async () => {
    const fetchImpl = vi.fn();
    const remote = createHttpRemote({ getToken: async () => null, fetchImpl });
    await expect(remote.pull('s')).rejects.toBeInstanceOf(TransportError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('échec de l’obtention du jeton (hors ligne) : erreur de transport, aucune requête', async () => {
    const fetchImpl = vi.fn();
    const client = createApiClient({
      getToken: async () => {
        throw new TypeError('Failed to fetch');
      },
      fetchImpl,
    });
    await expect(client('/api/sync/pull', {})).rejects.toBeInstanceOf(TransportError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('création de boutique : envoie name (ou chaîne vide) à /api/shop/ensure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x', name: 'Ma boutique', created: true }));
    const remote = createHttpRemote({ getToken: async () => 'jeton', fetchImpl });
    await remote.ensureShop(null);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: '' });
  });
});
