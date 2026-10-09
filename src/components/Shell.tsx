/** Coque de l'application : en-tête, bannières d'état, contenu et navigation principale (5 onglets). */
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../app/AppContext';
import { Banner } from './ui';
import { IconAlert, IconBox, IconCart, IconCog, IconHome, IconList, IconOffline, IconSync } from './icons';
import { formatDateTime } from '../lib/dates';

const NAV = [
  { to: '/', label: 'Tableau de bord', end: true, Icon: IconHome },
  { to: '/articles', label: 'Articles', end: false, Icon: IconBox },
  { to: '/historique', label: 'Historique', end: false, Icon: IconList },
  { to: '/parametres', label: 'Paramètres', end: false, Icon: IconCog },
] as const;

function SyncPill() {
  const { online, pendingCount, sync, syncNow, mode } = useApp();
  if (mode === 'local') {
    return <span className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900">Mode local</span>;
  }
  if (!online) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800">
        <IconOffline size={16} /> Hors ligne{pendingCount > 0 ? ` · ${pendingCount} en attente` : ''}
      </span>
    );
  }
  if (sync.running) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-900">
        <IconSync size={16} className="animate-spin" /> Synchronisation…
      </span>
    );
  }
  if (pendingCount > 0) {
    return (
      <button
        type="button"
        onClick={syncNow}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-200"
      >
        <IconSync size={16} /> {pendingCount} en attente · Synchroniser
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={syncNow}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-200"
      title="Lancer une synchronisation"
    >
      Synchronisé
    </button>
  );
}

export function Shell() {
  const { shop, mode, online, pendingCount, sync, lastSyncAt } = useApp();
  const location = useLocation();
  const needsAttention = sync.lastReport?.needsAttention ?? 0;

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <header className="safe-top sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-sm font-extrabold text-white" aria-hidden="true">
              SF
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-900">{shop?.name ?? 'ShopFlow RDC'}</p>
              <p className="truncate text-xs text-slate-500">
                {lastSyncAt ? `Dernière synchro : ${formatDateTime(lastSyncAt)}` : 'Jamais synchronisé'}
              </p>
            </div>
          </div>
          <SyncPill />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 pb-32 pt-4">
        <div className="flex flex-col gap-4">
          {mode === 'local' && (
            <Banner tone="warning" title="Mode local : données sur cet appareil uniquement">
              Aucune sauvegarde distante n’est active. Pour sauvegarder et synchroniser, configurez Supabase (voir le README).
            </Banner>
          )}
          {!online && (
            <Banner tone="info" title="Vous êtes hors ligne">
              Vous pouvez continuer à enregistrer ventes et articles. Tout sera envoyé au retour d’Internet.
            </Banner>
          )}
          {needsAttention > 0 && (
            <Banner
              tone="danger"
              title={`${needsAttention} opération(s) à vérifier`}
              action={
                <NavLink to="/parametres" className="inline-flex min-h-10 items-center rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white">
                  Voir les problèmes
                </NavLink>
              }
            >
              Certaines données n’ont pas pu être envoyées. Rien n’a été perdu : elles restent enregistrées sur cet appareil.
            </Banner>
          )}
          {pendingCount > 0 && needsAttention === 0 && online && !sync.running && mode === 'remote' && (
            <p className="flex items-center gap-2 text-sm text-slate-600">
              <IconAlert size={16} className="text-amber-600" /> {pendingCount} opération(s) en attente d’envoi.
            </p>
          )}
          <main key={location.pathname.split('/')[1] ?? 'root'} className="sf-fade-in">
            <Outlet />
          </main>
        </div>
      </div>

      <nav aria-label="Navigation principale" className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/98 shadow-[0_-4px_16px_rgba(15,23,42,0.06)] backdrop-blur">
        <ul className="mx-auto grid max-w-3xl grid-cols-5 items-end px-2 pt-2">
          {NAV.slice(0, 2).map(({ to, label, end, Icon }) => (
            <li key={to}>
              <NavItem to={to} end={end} label={label} Icon={Icon} />
            </li>
          ))}
          <li className="flex justify-center">
            <NavLink
              to="/commande"
              aria-label="Nouvelle commande"
              className={({ isActive }) =>
                `-mt-6 flex min-h-16 min-w-20 flex-col items-center justify-center gap-0.5 rounded-full px-2 py-2 text-xs font-bold shadow-lg ring-4 ring-white transition active:scale-95 ${
                  isActive ? 'bg-brand-800 text-white' : 'bg-brand-700 text-white hover:bg-brand-800'
                }`
              }
            >
              <IconCart size={24} />
              <span className="max-w-[5.5rem] text-center text-[10px] leading-tight">Nouvelle commande</span>
            </NavLink>
          </li>
          {NAV.slice(2).map(({ to, label, end, Icon }) => (
            <li key={to}>
              <NavItem to={to} end={end} label={label} Icon={Icon} />
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function NavItem({ to, end, label, Icon }: { to: string; end: boolean; label: string; Icon: (p: { size?: number }) => React.ReactElement }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[11px] font-semibold transition ${
          isActive ? 'text-brand-800' : 'text-slate-500 hover:text-slate-800'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span className={`flex h-8 w-12 items-center justify-center rounded-full transition ${isActive ? 'bg-brand-100' : ''}`}>
            <Icon size={22} />
          </span>
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}
