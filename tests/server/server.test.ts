/**
 * Tests de la configuration et des routes publiques du serveur (sans base ni authentification).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { readConfig } from '../../server/index.js';
import { authOrigin, jwksUrl } from '../../server/auth.js';

const NO_DIST = '/nonexistent-shopflow-test-dist';
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({ distDir: NO_DIST, authUrl: 'https://ep-test.neonauth.example/neondb/auth' });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('serveur : /healthz', () => {
  it('répond ok avec le code 200 et indique l’état de la configuration', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; built: boolean; database: string; auth: string };
    expect(body).toMatchObject({ status: 'ok', built: false, database: 'missing', auth: 'missing' });
  });
});

describe('serveur : /api/config', () => {
  it('renvoie uniquement l’URL publique Neon Auth, sans aucun secret', async () => {
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ authUrl: 'https://ep-test.neonauth.example/neondb/auth' });
    expect(text).not.toMatch(/postgres|DATABASE|secret|password/i);
  });

  it('lit NEON_AUTH_URL sans barre finale ; une valeur vide ou invalide donne une URL vide', () => {
    expect(readConfig({ NEON_AUTH_URL: 'https://ep-x.neonauth.example/neondb/auth/' }).authUrl).toBe('https://ep-x.neonauth.example/neondb/auth');
    expect(readConfig({}).authUrl).toBe('');
  });
});

describe('serveur : configuration des variables d’environnement', () => {
  it('port et hôte par défaut ; migrations au démarrage activées par défaut', () => {
    const c = readConfig({});
    expect(c).toMatchObject({ port: 3000, host: '0.0.0.0', databaseUrl: '', migrateOnStart: true });
  });

  it('PORT fourni par Render est respecté ; MIGRATE_ON_START=false désactive les migrations', () => {
    expect(readConfig({ PORT: '10000', MIGRATE_ON_START: 'false' })).toMatchObject({ port: 10000, migrateOnStart: false });
  });

  it('l’URL de Neon Auth doit être une URL http(s) ; son JWKS garde le chemin de l’URL', () => {
    expect(authOrigin('https://ep-x.neonauth.example/neondb/auth')).toBe('https://ep-x.neonauth.example');
    expect(() => authOrigin('pas une url')).toThrow(/valide/);
    expect(jwksUrl('https://ep-x.neonauth.example/neondb/auth/')).toBe('https://ep-x.neonauth.example/neondb/auth/.well-known/jwks.json');
  });
});

describe('serveur : application compilée', () => {
  it('sert index.html pour une route de l’application, et renvoie 404 JSON pour une route /api inconnue', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'shopflow-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ShopFlow</title>');
    const app = createApp({ distDir: dist });
    const srv: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const page = await fetch(`${url}/articles/42`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('ShopFlow');
      expect(page.headers.get('cache-control')).toBe('no-cache');

      const api = await fetch(`${url}/api/inconnue`);
      expect(api.status).toBe(404);
      expect(await api.json()).toEqual({ error: 'not_found' });
    } finally {
      await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
