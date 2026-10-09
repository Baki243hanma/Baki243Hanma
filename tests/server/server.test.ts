/**
 * Tests du serveur Express : santé, configuration publique, refus des clés « service_role ».
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/index.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const ORIGINAL = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };

beforeEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = ORIGINAL.url;
  if (ORIGINAL.key === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = ORIGINAL.key;
});

/** Construit un JWT factice (non signé) : seul le payload compte pour le garde-fou. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature-factice`;
}

describe('serveur : /healthz', () => {
  it('répond ok avec le code 200', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; built: boolean };
    expect(body.status).toBe('ok');
    expect(typeof body.built).toBe('boolean');
  });
});

describe('serveur : /api/config', () => {
  it('renvoie l’URL et la clé anonyme quand elles sont configurées', async () => {
    process.env.SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.SUPABASE_ANON_KEY = fakeJwt({ role: 'anon', iss: 'supabase' });
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { supabaseUrl: string; supabaseAnonKey: string };
    expect(body.supabaseUrl).toBe('https://abcdefgh.supabase.co');
    expect(body.supabaseAnonKey).toBe(process.env.SUPABASE_ANON_KEY);
  });

  it('renvoie une configuration vide (mode local) quand rien n’est configuré', async () => {
    const res = await fetch(`${base}/api/config`);
    expect(await res.json()).toEqual({ supabaseUrl: '', supabaseAnonKey: '' });
  });

  it('refuse une clé service_role (JWT) et ne la transmet jamais', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.SUPABASE_ANON_KEY = fakeJwt({ role: 'service_role', iss: 'supabase' });
    const res = await fetch(`${base}/api/config`);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ supabaseUrl: '', supabaseAnonKey: '' });
    expect(text).not.toContain(process.env.SUPABASE_ANON_KEY);
    expect(spy).toHaveBeenCalled();
  });

  it('refuse une clé secrète au nouveau format (sb_secret_…)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'sb_secret_0123456789abcdefghij';
    const body = (await (await fetch(`${base}/api/config`)).json()) as { supabaseAnonKey: string };
    expect(body.supabaseAnonKey).toBe('');
  });

  it('n’expose pas de configuration si l’URL est invalide', async () => {
    process.env.SUPABASE_URL = 'pas une url';
    process.env.SUPABASE_ANON_KEY = 'sb_publishable_exemple';
    const body = await (await fetch(`${base}/api/config`)).json();
    expect(body).toEqual({ supabaseUrl: '', supabaseAnonKey: '' });
  });
});

describe('serveur : sécurité des en-têtes', () => {
  it('ajoute les en-têtes de sécurité de base', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
