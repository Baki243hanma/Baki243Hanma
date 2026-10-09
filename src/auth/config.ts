/**
 * Configuration d'authentification à l'exécution.
 *
 * Source principale : GET /api/config (variable NEON_AUTH_URL du serveur, non secrète).
 * Repli : cache local, pour démarrer l'application hors ligne.
 * Dernier recours : mode local (aucune authentification, données sur cet appareil).
 *
 * Aucune clé ni aucun secret n'est lu ici : l'URL Neon Auth est publique par conception.
 */

export interface RuntimeConfig {
  authUrl: string;
  source: 'server' | 'cache' | 'none';
}

const CACHE_KEY = 'shopflow-rdc.config';

function isHttpsOrHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function normalizeAuthUrl(raw: { authUrl?: unknown }): string | null {
  const url = typeof raw.authUrl === 'string' ? raw.authUrl.trim().replace(/\/+$/, '') : '';
  if (!url || !isHttpsOrHttpUrl(url)) return null;
  return url;
}

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const res = await fetchImpl('/api/config', { cache: 'no-store' });
    if (res.ok) {
      const authUrl = normalizeAuthUrl((await res.json()) as { authUrl?: unknown });
      if (authUrl) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ authUrl }));
        } catch {
          /* stockage indisponible : pas de cache */
        }
        return { authUrl, source: 'server' };
      }
      return { authUrl: '', source: 'none' };
    }
  } catch {
    /* hors ligne : on tente le cache */
  }

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const authUrl = normalizeAuthUrl(JSON.parse(cached));
      if (authUrl) return { authUrl, source: 'cache' };
    }
  } catch {
    /* cache illisible */
  }

  return { authUrl: '', source: 'none' };
}
