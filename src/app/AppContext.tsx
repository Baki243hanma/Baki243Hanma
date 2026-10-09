/**
 * Contexte applicatif : configuration, session, base locale par compte,
 * boutique, état réseau et synchronisation.
 *
 * Deux modes :
 *  - « remote » : Neon Auth configuré -> connexion obligatoire, données synchronisées via l'API.
 *  - « local »  : Neon Auth non configuré -> mode de développement, données sur cet appareil
 *                 uniquement (affiché clairement à l'utilisateur).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ShopDatabase, databaseName } from '../db/database';
import { countPendingOperations, updateShopName } from '../db/repo';
import { newId } from '../lib/ids';
import { loadRuntimeConfig, type RuntimeConfig } from '../auth/config';
import { createNeonAuthClient, type AuthClient } from '../auth/client';
import { createHttpRemote, ServerError, TransportError, type RemoteAdapter } from '../sync/remote';
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
  const raw = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error ?? '');
  const msg = raw.toLowerCase();
  if (msg.includes('invalid email or password') || msg.includes('invalid credentials')) return 'Email ou mot de passe incorrect.';
  if (msg.includes('email not verified') || msg.includes('not verified')) {
    return 'Confirmez votre adresse email (lien reçu par email) avant de vous connecter.';
  }
  if (msg.includes('already exists') || msg.includes('already registered')) {
    return 'Un compte existe déjà avec cet email. Connectez-vous.';
  }
  if (msg.includes('password') && (msg.includes('at least') || msg.includes('short') || msg.includes('minimum'))) {
    return 'Le mot de passe doit contenir au moins 8 caractères.';
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

/** Identité mémorisée : permet de rester sur sa base locale hors ligne (session non vérifiable). */
const USER_CACHE_KEY = 'shopflow-rdc.user';

function readCachedUser(): { userId: string; email: string | null } | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: unknown; email?: unknown };
    if (typeof parsed.userId !== 'string' || parsed.userId.length === 0) return null;
    return { userId: parsed.userId, email: typeof parsed.email === 'string' ? parsed.email : null };
  } catch {
    return null;
  }
}

function writeCachedUser(user: { userId: string; email: string | null } | null): void {
  try {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* stockage indisponible */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [client, setClient] = useState<AuthClient | null>(null);
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
    void loadRuntimeConfig().then(async (cfg) => {
      if (!active) return;
      setConfig(cfg);
      if (!cfg.authUrl) {
        setAuth({ status: 'local', userId: null, email: null });
        return;
      }
      const c = createNeonAuthClient(cfg.authUrl);
      setClient(c);
      try {
        const res = await c.getSession();
        if (!active) return;
        const user = res.data?.user;
        if (user) {
          const identity = { userId: user.id, email: user.email ?? null };
          writeCachedUser(identity);
          setAuth({ status: 'signed_in', ...identity });
        } else if (!res.error) {
          // Réponse définitive : aucune session.
          writeCachedUser(null);
          setAuth({ status: 'signed_out', userId: null, email: null });
        } else {
          // Vérification impossible (hors ligne) : on garde l'identité connue pour rester sur sa base locale.
          const cached = readCachedUser();
          setAuth(cached ? { status: 'signed_in', ...cached } : { status: 'signed_out', userId: null, email: null });
        }
      } catch {
        if (!active) return;
        const cached = readCachedUser();
        setAuth(cached ? { status: 'signed_in', ...cached } : { status: 'signed_out', userId: null, email: null });
      }
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

  // Client HTTP de l'API (jeton Neon Auth à chaque appel).
  // Jeton Neon Auth (JWT) fourni à chaque appel. Une erreur réseau remonte telle quelle (opération en attente).
  const api = useMemo(() => {
    if (!client) return null;
    return createHttpRemote({
      getToken: async () => {
        const { data, error } = await client.token();
        if (error) return null;
        return data?.token ?? null;
      },
    });
  }, [client]);
  // 5. Création de la boutique côté serveur (première connexion)
  useEffect(() => {
    if (!db || !api || auth.status !== 'signed_in' || !shopLoaded || shop || !online) return;
    let cancelled = false;
    void (async () => {
      try {
        const row = await api.ensureShop(nameHint);
        if (cancelled) return;
        await db.meta.put({ key: 'shop', value: { id: row.id, name: row.name } });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ServerError && err.code === '22023') {
          setSetupNeedsName(true);
          return;
        }
        if (err instanceof ServerError) {
          setShopSetupError(`Le serveur a refusé la configuration de la boutique : ${err.message}`);
          return;
        }
        setShopSetupError('Connexion nécessaire pour configurer votre boutique la première fois.');
        return;
      }
      setSetupNeedsName(false);
      setShopSetupError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, api, auth.status, shopLoaded, shop, online, nameHint]);

  // 6. Synchronisation
  const remote: RemoteAdapter | null = api;
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
  const refreshAuth = useCallback(async () => {
    if (!client) return;
    const res = await client.getSession();
    const user = res.data?.user;
    if (user) {
      const identity = { userId: user.id, email: user.email ?? null };
      writeCachedUser(identity);
      setAuth({ status: 'signed_in', ...identity });
    } else {
      writeCachedUser(null);
      setAuth({ status: 'signed_out', userId: null, email: null });
    }
  }, [client]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!client) throw new Error('Authentification non configurée.');
      const { error } = await client.signIn.email({ email: email.trim(), password });
      if (error) throw new Error(authErrorMessage(error));
      await refreshAuth();
    },
    [client, refreshAuth],
  );

  const signUp = useCallback(
    async (email: string, password: string, shopName: string) => {
      if (!client) throw new Error('Authentification non configurée.');
      const cleanName = shopName.trim();
      const { error } = await client.signUp.email({ name: cleanName, email: email.trim(), password });
      if (error) throw new Error(authErrorMessage(error));
      setNameHint(cleanName);
      const res = await client.getSession();
      const hasSession = Boolean(res.data?.session);
      await refreshAuth();
      return { needsEmailConfirmation: !hasSession };
    },
    [client, refreshAuth],
  );

  const signOut = useCallback(async () => {
    if (!client) return;
    // Les données restent sur l'appareil : seule la session est fermée.
    try {
      await client.signOut();
    } finally {
      writeCachedUser(null);
      setAuth({ status: 'signed_out', userId: null, email: null });
    }
  }, [client]);

  const completeShopSetup = useCallback(
    async (name: string) => {
      const clean = name.trim();
      if (clean.length === 0 || clean.length > 120) throw new Error('Le nom de la boutique doit contenir entre 1 et 120 caractères.');
      if (!db) throw new Error('Base locale non prête.');
      if (api && auth.status === 'signed_in') {
        setNameHint(clean);
        let row: { id: string; name: string };
        try {
          row = await api.ensureShop(clean);
        } catch (err) {
          if (err instanceof ServerError) throw new Error(`Refus du serveur : ${err.message}`);
          throw new TransportError('Connexion Internet nécessaire pour créer votre boutique.');
        }
        await db.meta.put({ key: 'shop', value: { id: row.id, name: row.name } });
        setSetupNeedsName(false);
        return;
      }
      await db.meta.put({ key: 'shop', value: { id: newId(), name: clean } });
      setSetupNeedsName(false);
    },
    [db, api, auth.status],
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
