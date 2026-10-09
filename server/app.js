/**
 * Application Express de ShopFlow RDC.
 *
 *  - /healthz            : contrôle de santé (Render).
 *  - /api/config         : URL publique de Neon Auth (aucun secret).
 *  - /api/shop/ensure    : crée la boutique du compte connecté si elle n'existe pas (POST).
 *  - /api/sync/apply     : applique une opération de synchronisation (POST).
 *  - /api/sync/pull      : renvoie l'état d'une boutique (POST).
 *  - Toute autre route GET : la PWA compilée (dist/), avec repli sur index.html.
 *
 * Le navigateur n'accède jamais à la base : toutes les écritures et lectures passent ici,
 * après vérification du jeton Neon Auth. Les fonctions SQL vérifient ensuite l'appartenance
 * à la boutique à partir de l'identifiant vérifié (voir docs/ARCHITECTURE.md).
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withUser } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIST = join(__dirname, '..', 'dist');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codes SQLSTATE de disponibilité (connexion, ressources, arrêt) : réponse 503, à réessayer. */
function isAvailabilityCode(code) {
  return /^(08|53|57)/.test(code);
}

/** Traduit une erreur de base en réponse HTTP. Erreurs SQL -> 422 avec le code (contrat du client). */
export function sendDatabaseError(res, error, logger) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^[0-9A-Z]{5}$/.test(code)) {
    if (isAvailabilityCode(code)) {
      return res.status(503).json({ error: 'database_unavailable' });
    }
    return res.status(422).json({ error: 'sql_error', code, message: String(error.message ?? '') });
  }
  logger?.error?.('[api] erreur interne :', error);
  return res.status(500).json({ error: 'internal_error' });
}

/** Lit le jeton « Bearer » et renvoie l'identifiant du compte, ou répond 401. */
function requireUser(verifyToken, logger) {
  return async (req, res, next) => {
    if (!verifyToken) {
      res.status(503).json({ error: 'auth_not_configured' });
      return;
    }
    const match = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
    if (!match) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      req.userId = await verifyToken(match[1]);
      next();
    } catch (error) {
      logger?.warn?.('[auth] jeton refusé :', error?.code ?? error?.message);
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}

function requireDatabase(db) {
  return (_req, res, next) => {
    if (!db) {
      res.status(503).json({ error: 'database_not_configured' });
      return;
    }
    next();
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Snapshot d'une boutique : lecture dans la même transaction (cohérence entre les tables). */
async function readSnapshot(tx, shopId) {
  const allowed = await tx.query('select public.is_shop_member($1::uuid) as ok', [shopId]);
  if (!allowed[0]?.ok) return null;

  const shop = await tx.query('select to_jsonb(s) as j from public.shops s where s.id = $1', [shopId]);
  const products = await tx.query('select to_jsonb(p) as j from public.products p where p.shop_id = $1 order by p.id', [shopId]);
  const orders = await tx.query(
    `select to_jsonb(o) || jsonb_build_object('order_items',
       coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from public.order_items i where i.order_id = o.id), '[]'::jsonb)
     ) as j
     from public.orders o where o.shop_id = $1 order by o.id`,
    [shopId],
  );
  const movements = await tx.query('select to_jsonb(m) as j from public.stock_movements m where m.shop_id = $1 order by m.id', [shopId]);

  return {
    shop: shop[0]?.j ?? null,
    products: products.map((r) => r.j),
    orders: orders.map((r) => r.j),
    movements: movements.map((r) => r.j),
  };
}

/**
 * @param {object} [options]
 * @param {object|null} [options.db]            adaptateur de base (createPgDatabase en production)
 * @param {Function|null} [options.verifyToken]  jeton -> identifiant de compte (createTokenVerifier)
 * @param {string} [options.authUrl]             URL publique Neon Auth (renvoyée par /api/config)
 * @param {string} [options.distDir]             dossier de la PWA compilée
 * @param {object} [options.logger]              journaux (console par défaut)
 */
export function createApp({ db = null, verifyToken = null, authUrl = '', distDir = DEFAULT_DIST, logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      built: existsSync(join(distDir, 'index.html')),
      database: db ? 'configured' : 'missing',
      auth: verifyToken ? 'configured' : 'missing',
    });
  });

  app.get('/api/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authUrl });
  });

  app.use(express.json({ limit: '256kb' }));

  const auth = requireUser(verifyToken, logger);
  const dbReady = requireDatabase(db);

  app.post('/api/shop/ensure', dbReady, auth, async (req, res) => {
    const raw = req.body?.name ?? '';
    if (typeof raw !== 'string') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    try {
      const rows = await withUser(db, req.userId, (tx) => tx.query('select public.ensure_shop($1) as r', [raw]));
      res.json(rows[0].r);
    } catch (error) {
      sendDatabaseError(res, error, logger);
    }
  });

  app.post('/api/sync/apply', dbReady, auth, async (req, res) => {
    const { op_id: opId, type, payload } = req.body ?? {};
    if (typeof opId !== 'string' || !UUID_RE.test(opId) || typeof type !== 'string' || !isPlainObject(payload)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    try {
      const rows = await withUser(db, req.userId, (tx) =>
        tx.query('select public.apply_sync_operation($1::uuid, $2::text, $3::jsonb) as result', [opId, type, JSON.stringify(payload)]),
      );
      res.json(rows[0].result);
    } catch (error) {
      sendDatabaseError(res, error, logger);
    }
  });

  app.post('/api/sync/pull', dbReady, auth, async (req, res) => {
    const shopId = req.body?.shop_id;
    if (typeof shopId !== 'string' || !UUID_RE.test(shopId)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    try {
      const snapshot = await withUser(db, req.userId, (tx) => readSnapshot(tx, shopId));
      if (snapshot === null) {
        res.status(403).json({ error: 'forbidden_shop' });
        return;
      }
      res.json(snapshot);
    } catch (error) {
      sendDatabaseError(res, error, logger);
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  if (existsSync(join(distDir, 'index.html'))) {
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest') || filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // Repli SPA : toute route GET inconnue renvoie l'application.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(distDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(503).type('text/plain; charset=utf-8').send(
        "ShopFlow RDC : l'application n'est pas compilée. Exécutez « npm run build » (ou « npm install », qui compile automatiquement).",
      );
    });
  }

  // Erreurs de corps JSON : réponse 400 au format JSON (et non une page HTML).
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      res.status(err.status ?? 400).json({ error: 'invalid_request' });
      return;
    }
    next(err);
  });

  return app;
}
