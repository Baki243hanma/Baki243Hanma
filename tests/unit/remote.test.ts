import { describe, expect, it } from 'vitest';
import { classifyRemoteError, ServerError, TransportError } from '../../src/sync/remote';

describe('classifyRemoteError', () => {
  it('considère un code SQLSTATE comme une erreur serveur (l’opération est marquée en échec)', () => {
    const e = classifyRemoteError({ code: '42501', message: 'forbidden_shop' });
    expect(e).toBeInstanceOf(ServerError);
    expect((e as ServerError).code).toBe('42501');
  });

  it('considère un code PostgREST (ex. session expirée) comme une erreur serveur, pas comme hors ligne', () => {
    const e = classifyRemoteError({ code: 'PGRST301', message: 'JWT expired' });
    expect(e).toBeInstanceOf(ServerError);
  });

  it('considère une erreur sans code (réseau coupé) comme une erreur de transport', () => {
    expect(classifyRemoteError({ message: 'TypeError: Failed to fetch' })).toBeInstanceOf(TransportError);
    expect(classifyRemoteError(null)).toBeInstanceOf(TransportError);
    expect(classifyRemoteError(undefined)).toBeInstanceOf(TransportError);
  });
});
