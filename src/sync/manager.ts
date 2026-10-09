/**
 * Déclenchement de la synchronisation :
 *  - à l'ouverture de l'application ;
 *  - au retour au premier plan (visibilitychange) ;
 *  - au retour de la connexion (événement « online ») ;
 *  - après une modification locale (anti-rebond) ;
 *  - toutes les 60 s quand l'application est visible ;
 *  - manuellement (bouton « Synchroniser maintenant »).
 * iOS suspend les pages en arrière-plan : aucune synchronisation n'est promise hors de l'application.
 */
import type { ShopDatabase } from '../db/database';
import type { RemoteAdapter } from './remote';
import { runSync, type SyncReport } from './engine';

export interface SyncState {
  running: boolean;
  lastReport: SyncReport | null;
  lastSyncAt: string | null;
  online: boolean;
}

const LOCK_NAME = 'shopflow-rdc-sync';

export class SyncManager {
  private state: SyncState;
  private listeners = new Set<() => void>();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<SyncReport | null> = Promise.resolve(null);
  private started = false;
  private readonly onlineHandler = () => {
    this.set({ online: true });
    void this.request('online');
  };
  private readonly offlineHandler = () => this.set({ online: false });
  private readonly visibilityHandler = () => {
    if (document.visibilityState === 'visible') void this.request('foreground');
  };
  /** Toute nouvelle opération locale déclenche un envoi rapproché (si la connexion le permet). */
  private readonly creatingHandler = () => {
    this.scheduleAfterLocalChange();
  };

  constructor(
    private readonly db: ShopDatabase,
    private readonly remote: RemoteAdapter | null,
    private readonly shopId: string | null,
    initialLastSync: string | null = null,
  ) {
    this.state = {
      running: false,
      lastReport: null,
      lastSyncAt: initialLastSync,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
    };
  }

  get enabled(): boolean {
    return this.remote !== null && this.shopId !== null;
  }

  getState(): SyncState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.db.sync_operations.hook('creating', this.creatingHandler);
    this.interval = setInterval(() => {
      if (document.visibilityState === 'visible') void this.request('timer');
    }, 60_000);
    void this.request('startup');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.db.sync_operations.hook('creating').unsubscribe(this.creatingHandler);
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    this.interval = null;
    this.debounce = null;
  }

  /** Demande une synchronisation rapprochée (après une modification locale). */
  scheduleAfterLocalChange(): void {
    if (!this.enabled) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.request('local-change');
    }, 1500);
  }

  /** Lance un cycle de synchronisation (les demandes simultanées sont fusionnées dans la file). */
  request(_reason: string): Promise<SyncReport | null> {
    if (!this.enabled) return Promise.resolve(null);
    this.chain = this.chain.then(() => this.runOnce(), () => this.runOnce());
    return this.chain;
  }

  private async runOnce(): Promise<SyncReport | null> {
    if (!this.remote || !this.shopId) return null;
    const remote = this.remote;
    const shopId = this.shopId;
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    if (!online) {
      const report: SyncReport = {
        outcome: 'offline',
        pushed: 0,
        waiting: 0,
        needsAttention: 0,
        pulled: false,
        message: 'Hors ligne : vos opérations seront envoyées au retour de la connexion.',
        finishedAt: new Date().toISOString(),
      };
      this.set({ online: false, lastReport: report });
      return report;
    }

    const execute = async (): Promise<SyncReport> => {
      this.set({ running: true, online: true });
      try {
        const report = await runSync({ db: this.db, remote, shopId });
        const lastSyncAt = report.outcome === 'synced' || report.outcome === 'partial' ? report.finishedAt : this.state.lastSyncAt;
        if (lastSyncAt && lastSyncAt !== this.state.lastSyncAt && report.pulled) {
          await this.db.meta.put({ key: 'lastSyncAt', value: lastSyncAt });
        }
        this.set({
          running: false,
          lastReport: report,
          lastSyncAt: report.pulled ? report.finishedAt : this.state.lastSyncAt,
          online: report.outcome !== 'offline',
        });
        return report;
      } catch (error) {
        const report: SyncReport = {
          outcome: 'error',
          pushed: 0,
          waiting: 0,
          needsAttention: 0,
          pulled: false,
          message: `Erreur de synchronisation : ${(error as Error).message}`,
          finishedAt: new Date().toISOString(),
        };
        this.set({ running: false, lastReport: report });
        return report;
      }
    };

    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks && typeof locks.request === 'function') {
      // Un seul onglet/cycle à la fois.
      const result = await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return null;
        return execute();
      });
      return result;
    }
    return execute();
  }
}
