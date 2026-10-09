/**
 * Configuration Supabase à l'exécution.
 *
 * Source principale : GET /api/config (variables d'environnement du serveur, ex. Render).
 * Repli : valeurs de build VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (développement).
 * Dernier recours : cache local, pour démarrer l'application hors ligne.
 *
 * ATTENTION : seule la clé « anon » (publique, protégée par RLS) est utilisée.
 * La clé service_role ne doit JAMAIS apparaître dans ce projet.
 */

export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  source: 'server' | 'cache' | 'build' | 'none';
}

const CACHE_KEY = 'shopflow-rdc.config';

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function normalizeConfig(raw: { supabaseUrl?: unknown; supabaseAnonKey?: unknown }): {
  supabaseUrl: string;
  supabaseAnonKey: string;
} | null {
  const url = typeof raw.supabaseUrl === 'string' ? raw.supabaseUrl.trim() : '';
  const key = typeof raw.supabaseAnonKey === 'string' ? raw.supabaseAnonKey.trim() : '';
  if (!url || !key) return null;
  if (!isHttpUrl(url)) return null;
  return { supabaseUrl: url, supabaseAnonKey: key };
}

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const res = await fetchImpl('/api/config', { cache: 'no-store' });
    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>;
      const normalized = normalizeConfig(json);
      if (normalized) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(normalized));
        } catch {
          /* stockage indisponible : pas de cache */
        }
        return { ...normalized, source: 'server' };
      }
      return { supabaseUrl: '', supabaseAnonKey: '', source: 'none' };
    }
  } catch {
    /* hors ligne : on tente le cache */
  }

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const normalized = normalizeConfig(JSON.parse(cached));
      if (normalized) return { ...normalized, source: 'cache' };
    }
  } catch {
    /* cache illisible */
  }

  const env = import.meta.env as Record<string, string | undefined>;
  const fromBuild = normalizeConfig({
    supabaseUrl: env.VITE_SUPABASE_URL,
    supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
  });
  if (fromBuild) return { ...fromBuild, source: 'build' };

  return { supabaseUrl: '', supabaseAnonKey: '', source: 'none' };
}
