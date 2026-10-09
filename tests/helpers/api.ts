/**
 * Serveur ShopFlow réel (Express, port éphémère) branché sur PGlite.
 *
 * Les jetons sont de vrais JWT EdDSA signés avec une clé Ed25519 générée pour le test ; le serveur
 * les vérifie comme il le ferait avec le JWKS de Neon Auth (jose, issuer = origine de l'URL).
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type Database } from '../../server/app.js';
import { createTokenVerifier } from '../../server/auth.js';
import { createHttpRemote, type RemoteAdapter } from '../../src/sync/remote';

export const TEST_AUTH_URL = 'https://ep-test-000000.neonauth.test.example/neondb/auth';
export const TEST_ISSUER = 'https://ep-test-000000.neonauth.test.example';
const KID = 'test-key-1';

export interface TestApi {
  baseUrl: string;
  /** Jeton valide pour ce compte. */
  tokenFor(userId: string, options?: { expiresIn?: string | number; issuer?: string; subject?: string | null }): Promise<string>;
  /** Jeton signé par une autre clé (doit être refusé). */
  foreignSignedToken(userId: string): Promise<string>;
  /** Adaptateur distant (client HTTP réel) pour un compte, ou sans session si null. */
  remoteFor(userId: string | null): RemoteAdapter;
  close(): Promise<void>;
}

async function ed25519() {
  return generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
}

export async function startTestApi(db: Database, distDir = '/nonexistent-shopflow-test-dist'): Promise<TestApi> {
  const { publicKey, privateKey } = await ed25519();
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'EdDSA', use: 'sig' };
  const verifyToken = createTokenVerifier({ authUrl: TEST_AUTH_URL, keySet: createLocalJWKSet({ keys: [publicJwk] }) });
  const silent = { error: () => {}, warn: () => {}, log: () => {} };
  const app = createApp({ db, verifyToken, authUrl: TEST_AUTH_URL, distDir, logger: silent });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const sign = async (key: CryptoKey, userId: string, options: { expiresIn?: string | number; issuer?: string; subject?: string | null }) => {
    let builder = new SignJWT({ email: `${userId}@example.test` })
      .setProtectedHeader({ alg: 'EdDSA', kid: KID })
      .setIssuedAt()
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setExpirationTime(options.expiresIn ?? '1h');
    if (options.subject !== null) builder = builder.setSubject(options.subject ?? userId);
    return builder.sign(key);
  };

  const api: TestApi = {
    baseUrl,
    tokenFor: (userId, options = {}) => sign(privateKey, userId, options),
    foreignSignedToken: async (userId) => sign((await ed25519()).privateKey, userId, {}),
    remoteFor(userId) {
      return createHttpRemote({
        baseUrl,
        getToken: async () => (userId ? api.tokenFor(userId) : null),
      });
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
  return api;
}
