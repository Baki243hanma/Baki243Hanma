import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReady } from '../app/useReady';
import { adjustStock, addStockEntry, setProductArchived } from '../db/repo';
import { Badge, Banner, Button, Card, Field, Sheet, Spinner, TextInput } from '../components/ui';
import { IconArchive, IconBack, IconEdit } from '../components/icons';
import { SyncBadge, StockBadge } from '../components/status';
import { ConfirmDialog, useAsyncAction } from '../components/Confirm';
import { SyncProblems } from '../components/SyncProblems';
import { useToast } from '../components/Toast';
import { formatDateTime } from '../lib/dates';
import { formatFC, formatInt, parseQuantity } from '../lib/money';
import { isLowStock } from '../lib/calc';
import type { StockMovement } from '../domain/types';

const MOVEMENT_LABELS: Record<StockMovement['type'], string> = {
  initial: 'Stock initial',
  entry: 'Entrée de stock',
  sale: 'Vente',
  cancel_restock: 'Annulation de vente',
  correction: 'Correction',
};

export function ProductDetailPage() {
  const { db } = useReady();
  const { id = '' } = useParams();
  const toast = useToast();

  const product = useLiveQuery(() => db.products.get(id), [db, id], undefined);
  const movements = useLiveQuery(
    () => db.stock_movements.where('product_id').equals(id).reverse().sortBy('created_at'),
    [db, id],
    [] as StockMovement[],
  );
  const opsCount = useLiveQuery(
    () => db.sync_operations.where('entity_id').equals(id).filter((o) => o.status !== 'done' && o.status !== 'void').count(),
    [db, id],
    0,
  );

  const [sheet, setSheet] = useState<null | 'entry' | 'correction'>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [sign, setSign] = useState<'add' | 'remove'>('add');
  const [formError, setFormError] = useState<string | null>(null);
  const { busy, run } = useAsyncAction();

  if (product === undefined) return <Spinner />;
  if (product === null) {
    return (
      <Banner tone="danger" title="Article introuvable">
        <Link to="/articles" className="font-semibold underline">Retour à la liste</Link>
      </Banner>
    );
  }

  const value = product.quantity * product.purchase_price;

  async function submitStock(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const n = parseQuantity(qty);
    if (n === null) {
      setFormError('Entrez une quantité entière supérieure à 0.');
      return;
    }
    if (sheet === 'correction') {
      if (note.trim().length < 3) {
        setFormError('Indiquez le motif de la correction (par ex. « Inventaire », « Casse »).');
        return;
      }
      const delta = sign === 'add' ? n : -n;
      if (sign === 'remove' && n > product!.quantity) {
        setFormError(`Impossible : il ne reste que ${product!.quantity} article(s).`);
        return;
      }
      await run(async () => {
        await adjustStock(db, id, delta, note);
        toast.show(`Stock corrigé : ${delta > 0 ? '+' : ''}${delta}.`, 'success');
        close();
      }, setFormError);
    } else {
      await run(async () => {
        await addStockEntry(db, id, n, note);
        toast.show(`${formatInt(n)} article(s) ajouté(s) au stock.`, 'success');
        close();
      }, setFormError);
    }
  }

  function close() {
    setSheet(null);
    setQty('');
    setNote('');
    setSign('add');
    setFormError(null);
  }

  async function toggleArchive() {
    await run(async () => {
      const archive = product!.status === 'active';
      await setProductArchived(db, id, archive);
      toast.show(archive ? 'Article archivé. Son historique est conservé.' : 'Article réactivé.', 'success');
      setArchiveOpen(false);
    }, (msg) => {
      setFormError(msg);
      setArchiveOpen(false);
    });
  }

  const archived = product.status === 'archived';

  return (
    <div className="flex flex-col gap-5">
      <Link to="/articles" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand-800">
        <IconBack size={18} /> Articles
      </Link>

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StockBadge product={product} />
          <SyncBadge status={product.sync_status} />
          {product.category && <Badge tone="neutral">{product.category}</Badge>}
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{product.name}</h1>
        {(opsCount ?? 0) > 0 && product.sync_status !== 'synced' && (
          <p className="text-sm text-slate-600">Modifications en attente d’envoi vers le serveur.</p>
        )}
      </header>

      {formError && !sheet && <Banner tone="danger">{formError}</Banner>}

      <div className="grid grid-cols-2 gap-3">
        <Card className="flex flex-col gap-1">
          <p className="text-sm text-slate-600">Stock disponible</p>
          <p className={`text-3xl font-extrabold tabular-nums ${product.quantity <= 0 ? 'text-rose-700' : isLowStock(product) ? 'text-amber-700' : 'text-brand-800'}`}>
            {formatInt(product.quantity)}
          </p>
          <p className="text-xs text-slate-500">Seuil d’alerte : {formatInt(product.alert_threshold)}</p>
        </Card>
        <Card className="flex flex-col gap-1">
          <p className="text-sm text-slate-600">Prix de vente</p>
          <p className="text-2xl font-bold tabular-nums text-slate-900">{formatFC(product.sale_price)}</p>
          <p className="text-xs text-slate-500">Achat : {formatFC(product.purchase_price)}</p>
        </Card>
      </div>
      <p className="text-sm text-slate-600">
        Valeur de ce stock au coût d’achat : <span className="font-semibold text-slate-900">{formatFC(value)}</span>
      </p>

      {!archived && (
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => setSheet('entry')}>+ Entrée de stock</Button>
          <Button variant="secondary" onClick={() => setSheet('correction')}>Corriger le stock</Button>
          <Link to={`/articles/${id}/modifier`} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-4 font-semibold text-brand-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
            <IconEdit size={18} /> Modifier
          </Link>
          <Button variant="ghost" onClick={() => setArchiveOpen(true)} className="text-slate-700">
            <IconArchive size={18} /> Archiver
          </Button>
        </div>
      )}
      {archived && (
        <div className="flex flex-col gap-3">
          <Banner tone="info" title="Article archivé">
            Il n’est plus proposé à la vente. Son historique est conservé. Vous pouvez le réactiver.
          </Banner>
          <Button onClick={() => setArchiveOpen(true)}>Réactiver l’article</Button>
        </div>
      )}

      <section aria-labelledby="sync-title" className="flex flex-col gap-3">
        <h2 id="sync-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">Synchronisation</h2>
        <SyncProblems />
      </section>

      <section aria-labelledby="mov-title" className="flex flex-col gap-3">
        <h2 id="mov-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">Mouvements de stock</h2>
        {movements && movements.length === 0 && <p className="text-sm text-slate-600">Aucun mouvement pour l’instant.</p>}
        <ul className="flex flex-col gap-2">
          {(movements ?? []).slice(0, 100).map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200/70">
              <div className="min-w-0">
                <p className="font-semibold text-slate-900">{MOVEMENT_LABELS[m.type]}</p>
                <p className="truncate text-xs text-slate-500">
                  {formatDateTime(m.created_at)}
                  {m.reason && m.type !== 'sale' ? ` · ${m.reason}` : ''}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={`font-bold tabular-nums ${m.quantity_delta > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {m.quantity_delta > 0 ? '+' : ''}
                  {formatInt(m.quantity_delta)}
                </p>
                <p className="text-xs text-slate-500">Stock : {formatInt(m.quantity_after)}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <Sheet
        open={sheet !== null}
        onClose={close}
        title={sheet === 'entry' ? 'Entrée de stock' : 'Corriger le stock'}
        footer={
          <Button type="submit" form="stock-form" block disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        }
      >
        <form id="stock-form" className="flex flex-col gap-5" onSubmit={submitStock} noValidate>
          <p className="text-sm text-slate-600">
            Stock actuel : <span className="font-semibold text-slate-900">{formatInt(product.quantity)}</span>
          </p>
          {sheet === 'correction' && (
            <div role="radiogroup" aria-label="Sens de la correction" className="grid grid-cols-2 gap-2">
              {(['add', 'remove'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={sign === s}
                  onClick={() => setSign(s)}
                  className={`min-h-12 rounded-xl text-sm font-semibold ring-1 ring-inset ${sign === s ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-slate-700 ring-slate-300'}`}
                >
                  {s === 'add' ? 'Ajouter au stock' : 'Retirer du stock'}
                </button>
              ))}
            </div>
          )}
          <Field label="Quantité" required error={formError && !qty.trim() ? formError : undefined}>
            {(fid, desc) => (
              <TextInput id={fid} aria-describedby={desc} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" autoFocus />
            )}
          </Field>
          <Field label={sheet === 'correction' ? 'Motif (obligatoire)' : 'Note (facultatif)'} required={sheet === 'correction'} hint={sheet === 'correction' ? 'Exemple : inventaire, casse, perte.' : 'Exemple : livraison du 12 octobre.'}>
            {(fid, desc) => (
              <TextInput id={fid} aria-describedby={desc} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
            )}
          </Field>
          {formError && <Banner tone="danger">{formError}</Banner>}
        </form>
      </Sheet>

      <ConfirmDialog
        open={archiveOpen}
        busy={busy}
        title={archived ? 'Réactiver cet article ?' : 'Archiver cet article ?'}
        message={
          archived
            ? 'L’article sera de nouveau proposé à la vente.'
            : 'L’article ne sera plus proposé à la vente. Son historique et ses anciennes commandes restent consultables. Vous pourrez le réactiver à tout moment.'
        }
        confirmLabel={archived ? 'Réactiver' : 'Archiver'}
        tone={archived ? 'primary' : 'warning'}
        onConfirm={toggleArchive}
        onCancel={() => setArchiveOpen(false)}
      />
    </div>
  );
}
