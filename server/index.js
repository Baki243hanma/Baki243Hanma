/**
 * Serveur ShopFlow RDC (Node.js + Express).
 *
 *  - Sert l'application PWA compilée (dossier dist/) avec repli sur index.html (SPA).
 *  - Expose /api/config : URL et clé ANONYME Supabase (publiques par conception, protégées par RLS).
 *    Aucune clé « service_role » n'est lue ni transmise.
 *  - Expose /healthz pour les contrôles de santé (Render).
 *
 * Variables d'environnement :
 *  - PORT (fourni par Render), HOST (défaut 0.0.0.0)
 *  - SUPABASE_URL, SUPABASE_ANON_KEY (facultatives : sans elles, l'application passe en mode local)
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

function publicConfig() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const anon = (process.env.SUPABASE_ANON_KEY || '').trim();
  // Garde-fou : refuse toute clé qui ressemble à une clé service_role (JWT dont le rôle est service_role).
  if (looksLikeServiceRoleKey(anon)) {
    console.error('[config] SUPABASE_ANON_KEY ressemble à une clé service_role : ignorée. Utilisez la clé anon.');
    return { supabaseUrl: '', supabaseAnonKey: '' };
  }
  if (!isHttpUrl(url) || anon === '') return { supabaseUrl: '', supabaseAnonKey: '' };
  return { supabaseUrl: url, supabaseAnonKey: anon };
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function looksLikeServiceRoleKey(key) {
  // Nouveau format de clés Supabase : « sb_secret_… » = clé serveur (jamais publique).
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && payload.role === 'service_role';
  } catch {
    return false;
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', built: existsSync(join(DIST, 'index.html')) });
  });

  app.get('/api/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicConfig());
  });

  if (existsSync(join(DIST, 'index.html'))) {
    app.use(
      express.static(DIST, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest') || filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${join('dist', 'assets')}`) || filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // Repli SPA : toute route inconnue renvoie l'application.
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(DIST, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(503).type('text/plain; charset=utf-8').send(
        "ShopFlow RDC : l'application n'est pas compilée. Exécutez « npm run build » (ou « npm install », qui compile automatiquement).",
      );
    });
  }

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`ShopFlow RDC en écoute sur http://${HOST}:${PORT}`);
    if (!publicConfig().supabaseUrl) {
      console.log('Supabase non configuré : mode local (données sur cet appareil uniquement).');
    }
  });
}

export { publicConfig };
