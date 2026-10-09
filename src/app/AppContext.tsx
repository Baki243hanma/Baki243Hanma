/**
 * Contexte applicatif : configuration, session, base locale par compte,
 * boutique, état réseau et synchronisation.
 *
 * Deux modes :
 *  - « remote » : Supabase configuré -> connexion obligatoire, données synchronisées.
 *  - « local »  : Supabase non configuré -> mode de développement, données sur cet appareil
 *                 uniquement (affiché clairement à l'utilisateur).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { ShopDatabase, databaseName } from '../db/database';
import { countPendingOperations, updateShopName } from '../db/repo';
import { newId } from '../lib/ids';
import { loadRuntimeConfig, type RuntimeConfig } from '../supabase/config';
import { createSupabaseClient } from '../supabase/client';
import { createSupabaseRemote, TransportError, type RemoteAdapter } from '../sync/remote';
import { SyncManager, type SyncState } from '../sync/manager';

export interface Shop {
  id: string;
  name: string;
}

export interface AuthView {
  status: 'loading' | 'local' | 'signed_out' | 'signed_in';
  userId: string | null;
  email: string | null;
}

export interface AppContextValue {
  mode: 'local' | 'remote';
  configSource: RuntimeConfig['source'];
  auth: AuthView;
  db: ShopDatabase | null;
  dbError: string | null;
  shop: Shop | null;
  /** Vrai quand la boutique doit être créée ou nommée par l'utilisateur. */
  needsShopSetup: boolean;
  shopSetupError: string | null;
  online: boolean;
  pendingCount: number;
  sync: SyncState;
  lastSyncAt: string | null;
  syncNow: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, shopName: string) => Promise<{ needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
  completeShopSetup: (name: string) => Promise<void>;
  renameShop: (name: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp doit être utilisé dans AppProvider');
  return ctx;
}

/** Traduit les erreurs d'authentification en français simple. */
export function authErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const msg = raw.toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Email ou mot de passe incorrect.';
  if (msg.includes('email not confirmed')) {
    return 'Confirmez votre adresse email (lien reçu par email) avant de vous connecter.';
  }
  if (msg.includes('already registered') || msg.includes('already been registered')) {
    return 'Un compte existe déjà avec cet email. Connectez-vous.';
  }
  if (msg.includes('password should be at least') || msg.includes('password')) {
    return 'Le mot de passe doit contenir au moins 6 caractères.';
  }
  if (msg.includes('rate limit') || msg.includes('too many')) {
    return 'Trop de tentatives. Patientez quelques minutes avant de réessayer.';
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('failed to fetch')) {
    return 'Connexion Internet nécessaire. Vérifiez votre réseau et réessayez.';
  }
  if (msg.includes('invalid email')) return 'Adresse email invalide.';
  return 'Connexion impossible pour le moment. Réessayez.';
}

function userEmail(user: User | null | undefined): string | null {
  return user?.email ?? null;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [auth, setAuth] = useState<AuthView>({ status: 'loading', userId: null, email: null });
  const [nameHint, setNameHint] = useState<string | null>(null);
  const [db, setDb] = useState<ShopDatabase | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [setupNeedsName, setSetupNeedsName] = useState(false);
  const [shopSetupError, setShopSetupError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ running: false, lastReport: null, lastSyncAt: null, online: true });
  const [manager, setManager] = useState<SyncManager | null>(null);

  // 1. Configuration + session
  useEffect(() => {
    let active = true;
    void loadRuntimeConfig().then((cfg) => {
      if (!active) return;
      setConfig(cfg);
      if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
        const c = createSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
        setClient(c);
        void c.auth.getSession().then(({ data }) => {
          if (!active) return;
          const session: Session | null = data.session;
          setAuth(session ? { status: 'signed_in', userId: session.user.id, email: userEmail(session.user) } : { status: 'signed_out', userId: null, email: null });
        });
        const { data: sub } = c.auth.onAuthStateChange((event, session) => {
          if (!active) return;
          if (session) {
            setAuth({ status: 'signed_in', userId: session.user.id, email: userEmail(session.user) });
          } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
            setAuth({ status: 'signed_out', userId: null, email: null });
          }
        });
        return () => sub.subscription.unsubscribe();
      }
      setAuth({ status: 'local', userId: null, email: null });
      return undefined;
    });
    return () => {
      active = false;
    };
  }, []);

  // 2. Connexion réseau
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // 3. Base locale propre à chaque compte
  const dbKey = auth.status === 'signed_in' ? auth.userId : auth.status === 'local' ? 'local' : null;
  useEffect(() => {
    if (dbKey === null) {
      setDb(null);
      return;
    }
    const instance = new ShopDatabase(databaseName(dbKey === 'local' ? null : dbKey));
    let cancelled = false;
    setDbError(null);
    instance
      .open()
      .then(() => {
        if (!cancelled) setDb(instance);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDbError(
            `Impossible d’ouvrir la mémoire de cet appareil (${(err as Error).message}). ` +
              'Vérifiez que le navigateur autorise le stockage (mode navigation privée désactivé sur iPhone).',
          );
        }
      });
    return () => {
      cancelled = true;
      instance.close();
      setDb(null);
    };
  }, [dbKey]);

  // 4. Boutique locale
  const shopRow = useLiveQuery(
    async () => (db ? { shop: ((await db.meta.get('shop'))?.value as Shop | undefined) ?? null } : undefined),
    [db],
  );
  const shop = shopRow?.shop ?? null;
  const shopLoaded = shopRow !== undefined;

  // 5. Création de la boutique côté serveur (première connexion)
  useEffect(() => {
    if (!db || !client || auth.status !== 'signed_in' || !shopLoaded || shop || !online) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await client.rpc('ensure_shop', { p_name: nameHint });
      if (cancelled) return;
      if (error) {
        if (String(error.message).includes('shop_name_required')) {
          setSetupNeedsName(true);
          return;
        }
        if (/^[0-9A-Z]{5}$/.test(error.code ?? '')) {
          setShopSetupError(`Le serveur a refusé la configuration de la boutique : ${error.message}`);
          return;
        }
        setShopSetupError('Connexion nécessaire pour configurer votre boutique la première fois.');
        return;
      }
      const row = data as { id: string; name: string };
      await db.meta.put({ key: 'shop', value: { id: row.id, name: row.name } });
      setSetupNeedsName(false);
      setShopSetupError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, client, auth.status, shopLoaded, shop, online, nameHint]);

  // 6. Synchronisation
  const remote: RemoteAdapter | null = useMemo(() => (client ? createSupabaseRemote(client) : null), [client]);
  const shopId = shop?.id ?? null;
  useEffect(() => {
    if (!db) {
      setManager(null);
      return;
    }
    const m = new SyncManager(db, remote, shopId);
    setManager(m);
    const unsubscribe = m.subscribe(() => setSyncState({ ...m.getState() }));
    setSyncState({ ...m.getState() });
    m.start();
    return () => {
      unsubscribe();
      m.stop();
      setManager(null);
    };
  }, [db, remote, shopId]);

  const pendingCount = useLiveQuery(() => (db ? countPendingOperations(db) : Promise.resolve(0)), [db], 0);
  const lastSyncRow = useLiveQuery(
    async () => (db ? ((await db.meta.get('lastSyncAt'))?.value as string | undefined) ?? null : null),
    [db],
    null,
  );

  const syncNow = useCallback(() => {
    void manager?.request('manual');
  }, [manager]);

  // ---- Actions d'authentification
  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!client) throw new Error('Authentification non configurée.');
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(authErrorMessage(error));
    },
    [client],
  );

  const signUp = useCallback(
    async (email: string, password: string, shopName: string) => {
      if (!client) throw new Error('Authentification non configurée.');
      const cleanName = shopName.trim();
      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { shop_name: cleanName },
          emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
        },
      });
      if (error) throw new Error(authErrorMessage(error));
      setNameHint(cleanName);
      return { needsEmailConfirmation: !data.session };
    },
    [client],
  );

  const signOut = useCallback(async () => {
    if (!client) return;
    // Portée « local » : la déconnexion fonctionne même hors ligne. Les données restent sur l'appareil.
    await client.auth.signOut({ scope: 'local' });
  }, [client]);

  const completeShopSetup = useCallback(
    async (name: string) => {
      const clean = name.trim();
      if (clean.length === 0 || clean.length > 120) throw new Error('Le nom de la boutique doit contenir entre 1 et 120 caractères.');
      if (!db) throw new Error('Base locale non prête.');
      if (client && auth.status === 'signed_in') {
        setNameHint(clean);
        const { data, error } = await client.rpc('ensure_shop', { p_name: clean });
        if (error) {
          if (/^[0-9A-Z]{5}$/.test(error.code ?? '')) throw new Error(`Refus du serveur : ${error.message}`);
          throw new TransportError('Connexion Internet nécessaire pour créer votre boutique.');
        }
        const row = data as { id: string; name: string };
        await db.meta.put({ key: 'shop', value: { id: row.id, name: row.name } });
        setSetupNeedsName(false);
        return;
      }
      await db.meta.put({ key: 'shop', value: { id: newId(), name: clean } });
      setSetupNeedsName(false);
    },
    [db, client, auth.status],
  );

  const renameShop = useCallback(
    async (name: string) => {
      if (!db || !shop) throw new Error('Boutique non prête.');
      const clean = name.trim();
      if (clean.length === 0 || clean.length > 120) throw new Error('Le nom de la boutique doit contenir entre 1 et 120 caractères.');
      await updateShopName(db, shop.id, clean);
    },
    [db, shop],
  );

  const value: AppContextValue = {
    mode: config?.source === 'none' || auth.status === 'local' ? 'local' : 'remote',
    configSource: config?.source ?? 'none',
    auth,
    db,
    dbError,
    shop,
    needsShopSetup: shopLoaded && !shop && (auth.status === 'local' || setupNeedsName || (auth.status === 'signed_in' && !online)),
    shopSetupError,
    online,
    pendingCount: pendingCount ?? 0,
    sync: syncState,
    lastSyncAt: lastSyncRow ?? null,
    syncNow,
    signIn,
    signUp,
    signOut,
    completeShopSetup,
    renameShop,
  };

  // Les pages affichent un état de chargement tant que la session ou la base ne sont pas prêtes.
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
