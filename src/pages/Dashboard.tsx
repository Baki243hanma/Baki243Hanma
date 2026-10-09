import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReady } from '../app/useReady';
import { loadDashboard } from '../db/queries';
import { computePeriod, formatDateTime, type PeriodKind } from '../lib/dates';
import { formatFC, formatInt } from '../lib/money';
import { Badge, Card, EmptyState, PageHeader, Spinner, Stat } from '../components/ui';
import { IconAlert, IconCart } from '../components/icons';
import { OrderStatusBadge } from '../components/status';
import { PeriodFilter, defaultCustomRange, type CustomRange } from '../components/PeriodFilter';
import { orderRef } from '../lib/ids';

export function DashboardPage() {
  const { db, shop } = useReady();
  const [kind, setKind] = useState<PeriodKind>('today');
  const [custom, setCustom] = useState<CustomRange>(() => defaultCustomRange());

  const period = useMemo(() => computePeriod(kind, new Date(), custom), [kind, custom]);

  const data = useLiveQuery(() => loadDashboard(db, period), [db, period.kind, period.start, period.end], undefined);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Tableau de bord"
        subtitle={<>Boutique : <span className="font-semibold text-slate-800">{shop.name}</span></>}
      />

      <Link
        to="/commande"
        className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-700 px-5 text-lg font-bold text-white shadow-md transition hover:bg-brand-800 active:scale-[0.99]"
      >
        <IconCart size={22} /> Nouvelle commande
      </Link>

      <PeriodFilter value={kind} onChange={setKind} custom={custom} onCustomChange={setCustom} />

      {data === undefined && <Spinner label="Calcul des ventes…" />}

      {data && (
        <>
          <section aria-labelledby="kpi-title" className="flex flex-col gap-3">
            <h2 id="kpi-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              {period.label}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Chiffre d’affaires" value={formatFC(data.revenue)} tone="brand" hint="Ventes confirmées (hors annulées)." />
              <Stat label="Commandes" value={formatInt(data.orderCount)} hint={data.orderCount === 0 ? 'Aucune vente sur cette période.' : undefined} />
              <Stat label="Articles vendus" value={formatInt(data.quantitySold)} />
              <Stat
                label="Marge brute estimée"
                value={formatFC(data.grossMargin)}
                tone="success"
                hint={`${data.marginPercent} % du chiffre d’affaires.`}
              />
            </div>
            <Card className="border-amber-200 bg-amber-50/60 ring-amber-200/70">
              <p className="text-sm leading-relaxed text-amber-950">
                <span className="font-semibold">Marge brute estimée</span> = chiffre d’affaires − coût d’achat des articles vendus.
                Elle ne tient pas compte du loyer, du transport, des salaires ni des autres dépenses : <span className="font-semibold">ce n’est pas le bénéfice net.</span>
              </p>
            </Card>
          </section>

          <section aria-labelledby="stock-title" className="flex flex-col gap-3">
            <h2 id="stock-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Stock
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Valeur du stock"
                value={formatFC(data.stockValue)}
                hint="Quantités × prix d’achat, à l’instant présent."
              />
              <Stat label="Articles en stock" value={formatInt(data.productsInStock)} hint={`${formatInt(data.lowStock.length)} en stock faible`} tone={data.lowStock.length > 0 ? 'warning' : 'default'} />
            </div>

            {!data.hasAnyProduct ? (
              <EmptyState
                title="Aucun article pour l’instant"
                action={
                  <Link to="/articles/nouveau" className="inline-flex min-h-12 items-center rounded-xl bg-brand-700 px-5 font-semibold text-white">
                    Créer mon premier article
                  </Link>
                }
              >
                Ajoutez vos produits une seule fois : prix, stock et seuil d’alerte. Vous pourrez ensuite enregistrer des commandes.
              </EmptyState>
            ) : data.lowStock.length > 0 ? (
              <Card>
                <div className="mb-3 flex items-center gap-2">
                  <IconAlert size={18} className="text-amber-600" />
                  <h3 className="font-semibold text-slate-900">Stock faible</h3>
                </div>
                <ul className="divide-y divide-slate-100">
                  {data.lowStock.slice(0, 8).map((p) => (
                    <li key={p.id}>
                      <Link to={`/articles/${p.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2">
                        <span className="min-w-0 truncate font-medium text-slate-800">{p.name}</span>
                        <Badge tone={p.quantity <= 0 ? 'danger' : 'warning'}>
                          {p.quantity <= 0 ? 'Rupture' : `Reste ${formatInt(p.quantity)}`}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : (
              <p className="text-sm text-slate-600">Aucun article en stock faible.</p>
            )}
          </section>

          <section aria-labelledby="series-title" className="flex flex-col gap-3">
            <h2 id="series-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Évolution des ventes
            </h2>
            <Card>
              {data.series.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-600">Aucune vente enregistrée sur cette période.</p>
              ) : (
                <SalesChart series={data.series} granularity={data.seriesGranularity} />
              )}
            </Card>
          </section>

          <section aria-labelledby="recent-title" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 id="recent-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Dernières commandes
              </h2>
              <Link to="/historique" className="text-sm font-semibold text-brand-800">
                Tout voir
              </Link>
            </div>
            {data.recentOrders.length === 0 ? (
              <EmptyState title="Aucune commande">Vos commandes apparaîtront ici dès la première vente.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.recentOrders.map((o) => (
                  <li key={o.id}>
                    <Link to={`/historique/${o.id}`} className="flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200/70">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900">
                          Commande {orderRef(o.id)}
                        </p>
                        <p className="text-xs text-slate-500">{formatDateTime(o.created_at)}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="font-bold tabular-nums text-slate-900">{formatFC(o.total_amount)}</span>
                        <OrderStatusBadge status={o.status} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SalesChart({
  series,
  granularity,
}: {
  series: { key: string; label: string; revenue: number; orders: number }[];
  granularity: 'hour' | 'day' | 'month';
}) {
  const max = Math.max(...series.map((s) => s.revenue), 1);
  const total = series.reduce((sum, s) => sum + s.revenue, 0);
  const unit = granularity === 'hour' ? 'par heure' : granularity === 'day' ? 'par jour' : 'par mois';
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-600">
        Chiffre d’affaires {unit}. Total : <span className="font-semibold text-slate-900">{formatFC(total)}</span>
      </p>
      <div role="img" aria-label={`Graphique des ventes ${unit} : ${series.map((s) => `${s.label} ${formatFC(s.revenue)}`).join(', ')}`} className="flex h-44 items-end gap-2 overflow-x-auto pb-1">
        {series.map((s) => {
          const height = Math.max(4, Math.round((s.revenue / max) * 100));
          return (
            <div key={s.key} className="flex h-full min-w-10 flex-1 flex-col items-center justify-end gap-1" title={`${s.label} : ${formatFC(s.revenue)} (${s.orders} commande(s))`}>
              <span className="text-[10px] font-semibold text-slate-600 tabular-nums">{s.revenue > 0 ? formatCompact(s.revenue) : ''}</span>
              <div className="w-full rounded-t-lg bg-brand-500" style={{ height: `${height}%` }} />
              <span className="text-[10px] text-slate-500">{s.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} k`;
  return String(value);
}

