import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Client Supabase côté navigateur. Utilise uniquement l'URL et la clé « anon » publique.
 * La session est persistée dans le stockage local pour fonctionner hors ligne après une première connexion.
 */
export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'shopflow-rdc-auth',
    },
  });
}
