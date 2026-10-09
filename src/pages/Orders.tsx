import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReady } from '../app/useReady';
import { cancelOrder } from '../db/repo';
import { checkOrderConsistency } from '../db/queries';
import { PAYMENT_LABELS, type Order, type OrderItem } from '../domain/types';
import { CANCEL_REASONS, validateReason } from '../domain/validation';
import { Badge, Banner, Button, Card, EmptyState, PageHeader, Sheet, Spinner, TextInput, Field } from '../components/ui';
import { IconBack, IconChevron, IconSearch } from '../components/icons';
import { OrderStatusBadge, SyncBadge } from '../components/status';
import { PeriodFilter, defaultCustomRange, type CustomRange } from '../components/PeriodFilter';
import { useToast } from '../components/Toast';
import { useAsyncAction } from '../components/Confirm';
import { computePeriod, formatDateTime, inPeriod, type PeriodKind, type Period } from '../lib/dates';
import { formatFC, formatInt, multiplyAmount } from '../lib/money';
import { orderRef } from '../lib/ids';
import { marginRate } from '../lib/calc';
import { useApp } from '../app/AppContext';

const PAGE_SIZE = 50;

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function OrdersPage() {
  const { db } = useReady();
  const [kind, setKind] = useState<PeriodKind>('all');
  const [custom, setCustom] = useState<CustomRange>(() => defaultCustomRange());
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const period: Period = useMemo(() => computePeriod(kind, new Date(), custom), [kind, custom]);
  const orders = useLiveQuery(() => db.orders.orderBy('created_at').reverse().toArray(), [db], undefined);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
    return (orders ?? []).filter((o) => {
      if (!inPeriod(o.created_at, period)) return false;
      if (q === '') return true;
      return o.id.replace(/-/g, '').toUpperCase().startsWith(q);
    });
  }, [orders, period, search]);

  const groups = useMemo(() => {
    const map = new Map<string, Order[]>();
    for (const o of filtered.slice(0, limit)) {
      const key = new Date(o.created_at).toDateString();
      const list = map.get(key) ?? [];
      list.push(o);
      map.set(key, list);
    }
    return [...map.entries()].map(([key, list]) => ({ key, label: dayLabel(list[0].created_at), orders: list }));
  }, [filtered, limit]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Historique" subtitle="Toutes vos commandes, y compris les annulées." />

      <label className="relative block">
        <span className="sr-only">Rechercher une commande par identifiant</span>
        <IconSearch size={20} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Identifiant, ex. 1A2B3C4D"
          autoCapitalize="characters"
          className="min-h-12 w-full rounded-xl border border-slate-300 bg-white py-3 pl-12 pr-4 text-base uppercase placeholder:normal-case placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-100"
        />
      </label>

      <PeriodFilter value={kind} onChange={setKind} custom={custom} onCustomChange={setCustom} includeAll ariaLabel="Filtrer par date" />

      {orders === undefined && <Spinner />}

      {orders && orders.length === 0 && (
        <EmptyState
          title="Aucune commande enregistrée"
          action={
            <Link to="/commande" className="inline-flex min-h-12 items-center rounded-xl bg-brand-700 px-5 font-semibold text-white">
              Faire une première vente
            </Link>
          }
        >
          Vos commandes apparaîtront ici avec leur date, leur total et leur état de synchronisation.
        </EmptyState>
      )}

      {orders && orders.length > 0 && filtered.length === 0 && (
        <EmptyState title="Aucune commande trouvée">
          {search ? `Aucune commande ne correspond à « ${search} » sur cette période.` : 'Aucune commande sur cette période. Essayez « Tout ».'}
        </EmptyState>
      )}

      {groups.map((g) => (
        <section key={g.key} aria-label={g.label} className="flex flex-col gap-2">
          <h2 className="px-1 text-sm font-semibold capitalize text-slate-500">{g.label}</h2>
          <ul className="flex flex-col gap-2">
            {g.orders.map((o) => (
              <li key={o.id}>
                <Link to={`/historique/${o.id}`} className="flex min-h-16 items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 active:scale-[0.99]">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold text-slate-900">
                      Commande {orderRef(o.id)}
                      <span className="text-xs font-normal text-slate-500">{new Date(o.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                      {PAYMENT_LABELS[o.payment_method]} · {formatInt(o.total_quantity)} art.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <OrderStatusBadge status={o.status} />
                      <SyncBadge status={o.sync_status} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`font-bold tabular-nums ${o.status === 'cancelled' ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{formatFC(o.total_amount)}</span>
                    <IconChevron size={18} className="text-slate-400" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {filtered.length > limit && (
        <Button variant="secondary" block onClick={() => setLimit((l) => l + PAGE_SIZE)}>
          Afficher plus de commandes ({formatInt(filtered.length - limit)} restantes)
        </Button>
      )}
    </div>
  );
}

export function OrderDetailPage() {
  const { db } = useReady();
  const { mode } = useApp();
  const { id = '' } = useParams();
  const toast = useToast();
  const order = useLiveQuery(() => db.orders.get(id), [db, id], undefined);
  const items = useLiveQuery(() => db.order_items.where('order_id').equals(id).toArray(), [db, id], [] as OrderItem[]);
  const ops = useLiveQuery(() => db.sync_operations.where('entity_id').equals(id).toArray(), [db, id], []);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState<string>(CANCEL_REASONS[0]);
  const [otherReason, setOtherReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const { busy, run } = useAsyncAction();

  if (order === undefined) return <Spinner />;
  if (order === null) {
    return (
      <Banner tone="danger" title="Commande introuvable">
        <Link to="/historique" className="font-semibold underline">Retour à l’historique</Link>
      </Banner>
    );
  }

  const consistent = checkOrderConsistency(order, items ?? []);
  const revenue = order.total_amount;
  const cost = order.total_cost;
  const margin = order.gross_margin;
  const latestOp = [...(ops ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).at(-1);

  async function confirmCancel() {
    const finalReason = reason === 'Autre' ? otherReason.trim() : reason;
    const err = validateReason(finalReason);
    if (err) {
      setCancelError(err);
      return;
    }
    setCancelError(null);
    await run(async () => {
      await cancelOrder(db, id, finalReason);
      toast.show('Commande annulée. Le stock a été restauré.', 'success');
      setCancelOpen(false);
    }, setCancelError);
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/historique" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand-800">
        <IconBack size={18} /> Historique
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <OrderStatusBadge status={order.status} />
          <SyncBadge status={order.sync_status} />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Commande {orderRef(order.id)}</h1>
        <p className="text-sm text-slate-600">
          {formatDateTime(order.created_at)} · {PAYMENT_LABELS[order.payment_method]}
        </p>
        {order.status === 'cancelled' && (
          <Banner tone="danger" title="Commande annulée">
            {order.cancelled_at && <p>Le {formatDateTime(order.cancelled_at)}.</p>}
            {order.cancel_reason && <p>Motif : {order.cancel_reason}</p>}
            <p className="mt-1">Cette commande reste dans l’historique. Le stock des articles a été restauré.</p>
          </Banner>
        )}
      </header>

      {!consistent && (
        <Banner tone="danger" title="Contrôle de cohérence échoué">
          Les totaux de cette commande ne correspondent pas à ses lignes. Ne modifiez rien et signalez-le à votre assistance.
        </Banner>
      )}

      <Card as="section" className="flex flex-col gap-1 p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Articles</h2>
        <ul className="divide-y divide-slate-100 px-4">
          {(items ?? []).map((it) => (
            <li key={it.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-semibold text-slate-900">{it.product_name}</p>
                <p className="text-sm text-slate-600">
                  {formatInt(it.quantity)} × {formatFC(it.unit_price)}
                </p>
              </div>
              <p className="shrink-0 font-bold tabular-nums">{formatFC(multiplyAmount(it.unit_price, it.quantity))}</p>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-4 text-sm">
          <div className="flex justify-between text-base">
            <span className="font-semibold text-slate-800">Total</span>
            <span className="font-extrabold tabular-nums text-slate-900">{formatFC(revenue)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Coût d’achat des articles</span>
            <span className="tabular-nums">{formatFC(cost)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Marge brute estimée</span>
            <span className="font-semibold tabular-nums text-emerald-800">
              {formatFC(margin)} ({marginRate(revenue, margin)} %)
            </span>
          </div>
          <p className="pt-1 text-xs text-slate-500">
            Marge brute = total − coût d’achat. Ce n’est pas le bénéfice net.
          </p>
        </div>
      </Card>

      <Card as="section" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Synchronisation</h2>
        <p className="text-sm text-slate-700">
          {order.sync_status === 'synced' && 'Cette commande est enregistrée sur le serveur.'}
          {order.sync_status === 'pending' && (mode === 'remote'
            ? 'Enregistrée sur cet appareil. En attente d’envoi au serveur.'
            : 'Enregistrée sur cet appareil (mode local, pas de serveur).')}
          {order.sync_status === 'failed' && 'L’envoi a échoué. Ouvrez Paramètres > Synchronisation pour voir la raison et choisir quoi faire.'}
          {order.sync_status === 'conflict' && 'Un conflit doit être résolu dans Paramètres > Synchronisation.'}
          {order.sync_status === 'void' && 'Cette commande n’a jamais été envoyée au serveur (abandonnée sur cet appareil).'}
        </p>
        {latestOp?.last_error && order.sync_status !== 'synced' && <p className="text-sm text-rose-700">{latestOp.last_error}</p>}
        <p className="text-xs text-slate-500">Dernière mise à jour : {formatDateTime(order.updated_at)}</p>
      </Card>

      {order.status === 'confirmed' && (
        <Button variant="danger" block onClick={() => setCancelOpen(true)} disabled={busy}>
          Annuler cette commande
        </Button>
      )}
      {order.status === 'confirmed' && (
        <p className="text-center text-xs text-slate-500">
          Une commande ne se supprime pas. L’annulation la garde dans l’historique et restaure le stock.
        </p>
      )}

      <Sheet
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Annuler la commande ?"
        footer={
          <div className="flex flex-col gap-2">
            <Button variant="danger" block onClick={() => void confirmCancel()} disabled={busy}>
              {busy ? 'Annulation…' : 'Confirmer l’annulation'}
            </Button>
            <Button variant="secondary" block onClick={() => setCancelOpen(false)} disabled={busy}>
              Retour
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-slate-700">
            Le stock des articles sera restauré. La commande restera visible dans l’historique avec le statut « Annulée ». Cette action est tracée.
          </p>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold text-slate-800">Raison</legend>
            {CANCEL_REASONS.map((r) => (
              <label key={r} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-4 ring-1 ring-inset ${reason === r ? 'bg-brand-50 ring-brand-600' : 'bg-white ring-slate-300'}`}>
                <input type="radio" name="cancel-reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="h-5 w-5 accent-brand-700" />
                <span className="font-medium text-slate-800">{r}</span>
              </label>
            ))}
          </fieldset>
          {reason === 'Autre' && (
            <Field label="Précisez la raison" required error={cancelError ?? undefined}>
              {(fid, desc) => (
                <TextInput id={fid} aria-describedby={desc} value={otherReason} onChange={(e) => setOtherReason(e.target.value)} maxLength={300} />
              )}
            </Field>
          )}
          {cancelError && reason !== 'Autre' && <Banner tone="danger">{cancelError}</Banner>}
        </div>
      </Sheet>

      {order.status === 'cancelled' && <Badge tone="neutral">Historique conservé</Badge>}
    </div>
  );
}
