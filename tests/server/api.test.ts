/**
 * Tests HTTP de l'API de synchronisation : authentification (JWT EdDSA), validation,
 * codes de réponse, migrations, et cohérence avec la base PGlite réelle.
 */
import type { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, sendDatabaseError } from '../../server/app.js';
import { migrate } from '../../server/db.js';
import { createTokenVerifier } from '../../server/auth.js';
import { asAdmin, createTestDatabase, createUser, pgliteDatabase } from '../helpers/pg';
import { startTestApi, TEST_AUTH_URL, type TestApi } from '../helpers/api';
import type { Server } from 'node:http';
import { newId } from '../../src/lib/ids';

let pg: PGlite;
let api: TestApi;

beforeAll(async () => {
  pg = await createTestDatabase();
  api = await startTestApi(pgliteDatabase(pg));
});

afterAll(async () => {
  await api.close();
  await pg.close();
});

async function post(path: string, body: unknown, token?: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${api.baseUrl}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('authentification : jetons Neon Auth', () => {
  it('sans jeton : 401 sur toutes les routes de données', async () => {
    for (const path of ['/api/shop/ensure', '/api/sync/apply', '/api/sync/pull']) {
      const res = await post(path, {}, null);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('jeton signé par une autre clé : refusé', async () => {
    const user = await createUser(pg, 'forge');
    const res = await post('/api/shop/ensure', { name: 'Faux' }, await api.foreignSignedToken(user));
    expect(res.status).toBe(401);
  });

  it('jeton expiré : refusé', async () => {
    const user = await createUser(pg, 'expire');
    const past = Math.floor(Date.now() / 1000) - 600;
    const res = await post('/api/shop/ensure', { name: 'Expiré' }, await api.tokenFor(user, { expiresIn: past }));
    expect(res.status).toBe(401);
  });

  it('jeton émis par un autre émetteur : refusé', async () => {
    const user = await createUser(pg, 'issuer');
    const res = await post('/api/shop/ensure', { name: 'Autre' }, await api.tokenFor(user, { issuer: 'https://autre.example' }));
    expect(res.status).toBe(401);
  });

  it('jeton sans identifiant de compte (sub) : refusé', async () => {
    const user = await createUser(pg, 'nosub');
    const res = await post('/api/shop/ensure', { name: 'Sans sub' }, await api.tokenFor(user, { subject: null }));
    expect(res.status).toBe(401);
  });

  it('jeton valide : accepté, et la boutique est liée au compte du jeton', async () => {
    const user = await createUser(pg, 'valid');
    const res = await post('/api/shop/ensure', { name: '  Boutique Valide  ' }, await api.tokenFor(user));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; created: boolean };
    expect(body).toMatchObject({ name: 'Boutique Valide', created: true });

    const again = (await (await post('/api/shop/ensure', { name: 'Ignoré' }, await api.tokenFor(user))).json()) as { id: string; created: boolean };
    expect(again).toMatchObject({ id: body.id, created: false });
  });

  it('la vérification exige l’algorithme EdDSA : un jeton HS256 est refusé', async () => {
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode('secret-de-test-suffisamment-long-0123456789');
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('x').setIssuer(new URL(TEST_AUTH_URL).origin).setExpirationTime('1h').sign(secret);
    const res = await post('/api/shop/ensure', { name: 'HS' }, token);
    expect(res.status).toBe(401);
  });
});

describe('validation des requêtes', () => {
  it('corps JSON mal formé : 400 au format JSON', async () => {
    const user = await createUser(pg, 'badjson');
    const res = await post('/api/sync/apply', '{pas du json', await api.tokenFor(user));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('identifiant d’opération qui n’est pas un UUID : 400', async () => {
    const user = await createUser(pg, 'baduuid');
    const res = await post('/api/sync/apply', { op_id: 'pas-un-uuid', type: 'create_order', payload: {} }, await api.tokenFor(user));
    expect(res.status).toBe(400);
  });

  it('charge utile qui n’est pas un objet : 400', async () => {
    const user = await createUser(pg, 'badpayload');
    const res = await post('/api/sync/apply', { op_id: newId(), type: 'create_order', payload: [1, 2] }, await api.tokenFor(user));
    expect(res.status).toBe(400);
  });

  it('nom de boutique absent et boutique inexistante : erreur SQL 22023 (422)', async () => {
    const user = await createUser(pg, 'noname');
    const res = await post('/api/shop/ensure', { name: '   ' }, await api.tokenFor(user));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'sql_error', code: '22023', message: 'shop_name_required' });
  });
});

describe('isolation des boutiques côté API', () => {
  it('lire la boutique d’un autre compte : 403 forbidden_shop', async () => {
    const owner = await createUser(pg, 'api-owner');
    const other = await createUser(pg, 'api-other');
    const created = (await (await post('/api/shop/ensure', { name: 'Privée' }, await api.tokenFor(owner))).json()) as { id: string };
    const res = await post('/api/sync/pull', { shop_id: created.id }, await api.tokenFor(other));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_shop' });
  });

  it('le propriétaire lit sa boutique : snapshot complet', async () => {
    const owner = await createUser(pg, 'api-reader');
    const created = (await (await post('/api/shop/ensure', { name: 'Lecture' }, await api.tokenFor(owner))).json()) as { id: string };
    const res = await post('/api/sync/pull', { shop_id: created.id }, await api.tokenFor(owner));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { shop: { id: string; name: string }; products: unknown[]; orders: unknown[]; movements: unknown[] };
    expect(snap.shop).toMatchObject({ id: created.id, name: 'Lecture' });
    expect(snap.products).toEqual([]);
    expect(snap.orders).toEqual([]);
    expect(snap.movements).toEqual([]);
  });

  it('une opération visant une boutique étrangère est refusée par la base (422, 42501) et rien n’est écrit', async () => {
    const owner = await createUser(pg, 'api-victim');
    const attacker = await createUser(pg, 'api-attacker');
    const created = (await (await post('/api/shop/ensure', { name: 'Victime' }, await api.tokenFor(owner))).json()) as { id: string };
    const res = await post(
      '/api/sync/apply',
      { op_id: newId(), type: 'upsert_product', payload: { shop_id: created.id, product: { id: newId(), name: 'Intrus', purchase_price: 1, sale_price: 2, quantity: 1, alert_threshold: 0, status: 'active', base_version: 0 } } },
      await api.tokenFor(attacker),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'sql_error', code: '42501' });
    await asAdmin(pg);
    const { rows } = await pg.query<{ n: number }>('select count(*)::int as n from public.products where shop_id = $1', [created.id]);
    expect(rows[0].n).toBe(0);
  });

  it('une opération valide renvoie le résultat de la fonction SQL (HTTP 200)', async () => {
    const owner = await createUser(pg, 'api-ok');
    const created = (await (await post('/api/shop/ensure', { name: 'Ok' }, await api.tokenFor(owner))).json()) as { id: string };
    const opId = newId();
    const productId = newId();
    const now = new Date().toISOString();
    const product = {
      id: productId, name: 'Stylo', category: null, purchase_price: 100, sale_price: 250, initial_quantity: 4,
      alert_threshold: 1, status: 'active', base_version: 0, created_at: now, updated_at: now,
    };
    const res = await post('/api/sync/apply', { op_id: opId, type: 'upsert_product', payload: { shop_id: created.id, product } }, await api.tokenFor(owner));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'applied', version: 1 });
    // Rejeu de la même opération : résultat enregistré, aucune écriture supplémentaire.
    const replay = await post('/api/sync/apply', { op_id: opId, type: 'upsert_product', payload: { shop_id: created.id, product } }, await api.tokenFor(owner));
    // Un rejeu renvoie le résultat enregistré, marqué duplicate : pas de nouvelle écriture.
    expect(await replay.json()).toMatchObject({ status: 'applied', version: 1, duplicate: true });
    await asAdmin(pg);
    const { rows: stored } = await pg.query<{ n: number; version: number }>(
      'select count(*)::int as n, max(version)::int as version from public.products where shop_id = $1',
      [created.id],
    );
    expect(stored[0]).toEqual({ n: 1, version: 1 });
  });
});

describe('configuration manquante', () => {
  it('sans base de données : 503 database_not_configured (et sans jeton, la réponse est la même)', async () => {
    const app = createApp({ db: null, verifyToken: async () => 'x', distDir: '/nonexistent' });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'database_not_configured' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('sans authentification configurée : 503 auth_not_configured, aucune donnée lue', async () => {
    const app = createApp({ db: pgliteDatabase(pg), verifyToken: null, distDir: '/nonexistent' });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/sync/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x.y.z' },
        body: JSON.stringify({ shop_id: newId() }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'auth_not_configured' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe('traduction des erreurs de base', () => {
  function fakeRes() {
    const out: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        out.status = code;
        return res;
      },
      json(body: unknown) {
        out.body = body;
        return res;
      },
    };
    return { res: res as unknown as import('express').Response, out };
  }

  it('erreur de connexion (classe 08) : 503, à réessayer', () => {
    const { res, out } = fakeRes();
    sendDatabaseError(res, Object.assign(new Error('connexion perdue'), { code: '08006' }), { error() {} });
    expect(out).toEqual({ status: 503, body: { error: 'database_unavailable' } });
  });

  it('erreur SQL : 422 avec le code SQLSTATE', () => {
    const { res, out } = fakeRes();
    sendDatabaseError(res, Object.assign(new Error('boom'), { code: '23505' }), { error() {} });
    expect(out).toEqual({ status: 422, body: { error: 'sql_error', code: '23505', message: 'boom' } });
  });

  it('erreur sans code SQL : 500 générique, sans détail interne', () => {
    const { res, out } = fakeRes();
    const logged: unknown[] = [];
    sendDatabaseError(res, new Error('secret interne'), { error: (...a: unknown[]) => logged.push(a) });
    expect(out).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(logged.length).toBe(1);
  });
});

describe('migrations', () => {
  it('appliquer à nouveau les migrations ne refait rien ; chaque fichier est enregistré une fois', async () => {
    const again = await migrate(pgliteDatabase(pg));
    expect(again).toEqual([]);
    const { rows } = await pg.query<{ name: string }>('select name from public.schema_migrations order by name');
    expect(rows.map((r) => r.name)).toEqual(['001_init_schema.sql', '002_rls_security.sql', '003_sync_functions.sql']);
  });

  it('une migration en erreur est annulée entièrement et n’est pas enregistrée', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shopflow-mig-'));
    writeFileSync(join(dir, '001_ok.sql'), 'create table public.essai_ok (id int);');
    writeFileSync(join(dir, '002_casse.sql'), 'create table public.essai_partiel (id int); insert into table_inexistante values (1);');
    const { PGlite } = await import('@electric-sql/pglite');
    const fresh = new PGlite();
    try {
      await expect(migrate(pgliteDatabase(fresh), dir)).rejects.toBeTruthy();
      const { rows } = await fresh.query<{ name: string }>('select name from public.schema_migrations order by name');
      expect(rows.map((r) => r.name)).toEqual(['001_ok.sql']);
      const partial = await fresh.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name = 'essai_partiel'");
      expect(partial.rows[0].n).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});

describe('vérificateur de jetons', () => {
  it('refuse une URL Neon Auth invalide dès la création', () => {
    expect(() => createTokenVerifier({ authUrl: 'ftp://exemple' })).toThrow();
  });
});
