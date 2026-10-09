import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReady } from '../app/useReady';
import { useApp } from '../app/AppContext';
import { createOrder, BusinessError } from '../db/repo';
import { DEFAULT_CATEGORIES, PAYMENT_LABELS, type PaymentMethod, type Product } from '../domain/types';
import { Badge, Banner, Button, Card, EmptyState, PageHeader, Sheet, Spinner } from '../components/ui';
import { IconCheck, IconCart, IconPlus, IconSearch } from '../components/icons';
import { useToast } from '../components/Toast';
import { formatFC, formatInt, multiplyAmount, addAmounts } from '../lib/money';
import { newId, orderRef } from '../lib/ids';
import { matchesSearch } from '../lib/text';
import type { CreatedOrder } from '../db/repo';

interface CartLine {
  product_id: string;
  quantity: number;
}

interface Draft {
  id: string;
  lines: CartLine[];
  payment: PaymentMethod | null;
}

const PAYMENTS: PaymentMethod[] = ['cash', 'mobile_money', 'other'];

export function NewOrderPage() {
  const { db, shop } = useReady();
  const { online, mode } = useApp();
  const toast = useToast();

  const products = useLiveQuery(() => db.products.toArray(), [db], undefined);
  const [draft, setDraft] = useState<Draft>(() => ({ id: newId(), lines: [], payment: null }));
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Toutes');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedOrder | null>(null);
  const savingRef = useRef(false);

  // Restaure le panier en cours (si l'application a été fermée pendant une vente).
  useEffect(() => {
    let cancelled = false;
    void db.meta.get('draftOrder').then((row) => {
      if (cancelled) return;
      const saved = row?.value as Draft | undefined;
      if (saved && Array.isArray(saved.lines) && saved.lines.length > 0) {
        setDraft(saved);
        toast.show('Panier restauré après la fermeture de l’application.', 'info');
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  // Sauvegarde immédiate du brouillon à chaque changement.
  useEffect(() => {
    if (!hydrated || result) return;
    if (draft.lines.length === 0 && draft.payment === null) {
      void db.meta.delete('draftOrder');
    } else {
      void db.meta.put({ key: 'draftOrder', value: draft });
    }
  }, [db, draft, hydrated, result]);

  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);

  const lines = useMemo(
    () =>
      draft.lines
        .map((l) => ({ line: l, product: byId.get(l.product_id) }))
        .filter((x): x is { line: CartLine; product: Product } => Boolean(x.product)),
    [draft.lines, byId],
  );

  const total = useMemo(() => addAmounts(0, ...lines.map(({ line, product }) => multiplyAmount(product.sale_price, line.quantity))), [lines]);
  const itemCount = lines.reduce((s, { line }) => s + line.quantity, 0);

  const categories = useMemo(() => {
    const set = new Set<string>(DEFAULT_CATEGORIES);
    for (const p of products ?? []) if (p.category) set.add(p.category);
    return ['Toutes', ...[...set].sort((a, b) => a.localeCompare(b, 'fr'))];
  }, [products]);

  const catalogue = useMemo(
    () =>
      (products ?? [])
        .filter((p) => p.status === 'active')
        .filter((p) => category === 'Toutes' || p.category === category)
        .filter((p) => matchesSearch(p.name, query))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [products, category, query],
  );

  function setLineQuantity(productId: string, quantity: number) {
    const product = byId.get(productId);
    if (!product) return;
    setError(null);
    if (quantity <= 0) {
      setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.product_id !== productId) }));
      return;
    }
    if (quantity > product.quantity) {
      setError(`Stock insuffisant pour « ${product.name} » : ${formatInt(product.quantity)} disponible(s).`);
      setDraft((d) => ({
        ...d,
        lines: d.lines.map((l) => (l.product_id === productId ? { ...l, quantity: product.quantity } : l)),
      }));
      return;
    }
    setDraft((d) => {
      const exists = d.lines.some((l) => l.product_id === productId);
      return {
        ...d,
        lines: exists
          ? d.lines.map((l) => (l.product_id === productId ? { ...l, quantity } : l))
          : [...d.lines, { product_id: productId, quantity }],
      };
    });
  }

  function addOne(product: Product) {
    if (product.quantity <= 0) {
      setError(`« ${product.name} » est en rupture de stock.`);
      return;
    }
    const current = draft.lines.find((l) => l.product_id === product.id)?.quantity ?? 0;
    setLineQuantity(product.id, current + 1);
  }

  async function confirmOrder() {
    if (savingRef.current) return; // Protection contre la double validation.
    if (!draft.payment) {
      setError('Choisissez le mode de paiement.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const created = await createOrder(db, shop.id, {
        id: draft.id,
        lines: lines.map(({ line }) => ({ product_id: line.product_id, quantity: line.quantity })),
        payment_method: draft.payment,
      });
      await db.meta.delete('draftOrder');
      setResult(created);
      setReviewOpen(false);
      toast.show('Commande enregistrée.', 'success');
    } catch (e) {
      const msg = e instanceof BusinessError ? e.message : 'La commande n’a pas pu être enregistrée. Rien n’a été modifié. Réessayez.';
      setError(msg);
      setReviewOpen(false);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function startNew() {
    setResult(null);
    setDraft({ id: newId(), lines: [], payment: null });
    setError(null);
  }

  if (products === undefined || !hydrated) return <Spinner />;

  if (result) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Commande enregistrée" />
        <Card className="flex flex-col items-center gap-4 py-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-800" aria-hidden="true">
            <IconCheck size={32} />
          </div>
          <div>
            <p className="text-lg font-bold text-slate-900">Commande {orderRef(result.order.id)}</p>
            <p className="mt-1 text-3xl font-extrabold tabular-nums text-brand-800">{formatFC(result.order.total_amount)}</p>
            <p className="mt-1 text-sm text-slate-600">{PAYMENT_LABELS[result.order.payment_method]} · {formatInt(result.order.total_quantity)} article(s)</p>
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-slate-600">
            {mode === 'remote'
              ? online
                ? 'La commande est enregistrée sur cet appareil et envoyée au serveur. Le stock a été mis à jour.'
                : 'La commande est enregistrée sur cet appareil. Elle sera envoyée dès le retour d’Internet.'
              : 'La commande est enregistrée sur cet appareil. Le stock a été mis à jour.'}
          </p>
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Button block onClick={startNew}>Nouvelle commande</Button>
            <Link to={`/historique/${result.order.id}`} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-white font-semibold text-brand-800 ring-1 ring-inset ring-slate-300">
              Voir la commande
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-8">
      <PageHeader title="Nouvelle commande" subtitle="Ajoutez les articles, vérifiez le total, puis choisissez le paiement." />

      {error && <Banner tone="danger">{error}</Banner>}

      {(products ?? []).filter((p) => p.status === 'active').length === 0 ? (
        <EmptyState
          title="Aucun article à vendre"
          action={
            <Link to="/articles/nouveau" className="inline-flex min-h-12 items-center rounded-xl bg-brand-700 px-5 font-semibold text-white">
              Créer un article
            </Link>
          }
        >
          Une commande se compose d’articles existants. Créez d’abord vos produits avec leur prix et leur stock.
        </EmptyState>
      ) : (
        <>
          <Card className="flex flex-col gap-4" as="section">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
                <IconCart size={20} className="text-brand-700" /> Panier
              </h2>
              {lines.length > 0 && <Badge tone="brand">{formatInt(itemCount)} article(s)</Badge>}
            </div>

            {lines.length === 0 ? (
              <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                Le panier est vide. Touchez un article ci-dessous pour l’ajouter.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {lines.map(({ line, product }) => (
                  <li key={line.product_id} className="flex flex-col gap-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{product.name}</p>
                        <p className="text-sm text-slate-500">{formatFC(product.sale_price)} l’unité</p>
                      </div>
                      <p className="shrink-0 font-bold tabular-nums text-slate-900">{formatFC(multiplyAmount(product.sale_price, line.quantity))}</p>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <Stepper
                        value={line.quantity}
                        max={product.quantity}
                        label={product.name}
                        onChange={(q) => setLineQuantity(product.id, q)}
                      />
                      <button type="button" onClick={() => setLineQuantity(product.id, 0)} className="min-h-11 rounded-lg px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                        Retirer
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <span className="text-base font-semibold text-slate-700">Total</span>
              <span className="text-2xl font-extrabold tabular-nums text-slate-900" aria-live="polite">{formatFC(total)}</span>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold text-slate-800">Mode de paiement <span className="text-rose-600">*</span></legend>
              <div className="grid grid-cols-3 gap-2">
                {PAYMENTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={draft.payment === p}
                    onClick={() => setDraft((d) => ({ ...d, payment: p }))}
                    className={`min-h-12 rounded-xl px-2 text-sm font-semibold ring-1 ring-inset transition ${
                      draft.payment === p ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {PAYMENT_LABELS[p]}
                  </button>
                ))}
              </div>
              {!draft.payment && lines.length > 0 && <p className="text-sm text-slate-600">Choisissez le mode de paiement pour pouvoir valider.</p>}
            </fieldset>

            <Button block disabled={lines.length === 0 || !draft.payment || saving} onClick={() => setReviewOpen(true)}>
              Vérifier et valider la commande
            </Button>
          </Card>

          <section aria-labelledby="catalogue-title" className="flex flex-col gap-3">
            <h2 id="catalogue-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">Articles à vendre</h2>
            <label className="relative block">
              <span className="sr-only">Rechercher un article</span>
              <IconSearch size={20} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher un article…"
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white py-3 pl-12 pr-4 text-base placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-100"
              />
            </label>
            <div role="group" aria-label="Filtrer par catégorie" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                  className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-semibold ${category === c ? 'bg-brand-700 text-white' : 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300'}`}
                >
                  {c}
                </button>
              ))}
            </div>

            {catalogue.length === 0 && <p className="py-4 text-center text-sm text-slate-600">Aucun article ne correspond à votre recherche.</p>}

            <ul className="flex flex-col gap-2">
              {catalogue.map((p) => {
                const inCart = draft.lines.find((l) => l.product_id === p.id)?.quantity ?? 0;
                const out = p.quantity <= 0;
                return (
                  <li key={p.id} className={`flex items-center justify-between gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70 ${out ? 'opacity-60' : ''}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-900">{p.name}</p>
                      <p className="text-sm text-slate-600">
                        <span className="font-semibold tabular-nums">{formatFC(p.sale_price)}</span> ·{' '}
                        <span className={out ? 'font-semibold text-rose-700' : ''}>{out ? 'Rupture' : `${formatInt(p.quantity)} en stock`}</span>
                      </p>
                    </div>
                    {inCart > 0 ? (
                      <Stepper value={inCart} max={p.quantity} label={p.name} onChange={(q) => setLineQuantity(p.id, q)} />
                    ) : (
                      <button
                        type="button"
                        onClick={() => addOne(p)}
                        disabled={out}
                        aria-label={`Ajouter ${p.name} au panier`}
                        className="inline-flex min-h-12 min-w-24 items-center justify-center gap-1 rounded-xl bg-brand-700 px-4 text-sm font-bold text-white disabled:bg-slate-300"
                      >
                        <IconPlus size={18} /> Ajouter
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      <Sheet
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Récapitulatif"
        footer={
          <div className="flex flex-col gap-2">
            <Button block onClick={() => void confirmOrder()} disabled={saving}>
              {saving ? 'Enregistrement…' : `Confirmer · ${formatFC(total)}`}
            </Button>
            <Button variant="secondary" block onClick={() => setReviewOpen(false)} disabled={saving}>
              Modifier la commande
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <ul className="divide-y divide-slate-100">
            {lines.map(({ line, product }) => (
              <li key={line.product_id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-900">{product.name}</p>
                  <p className="text-sm text-slate-500">
                    {formatInt(line.quantity)} × {formatFC(product.sale_price)}
                  </p>
                </div>
                <p className="font-bold tabular-nums">{formatFC(multiplyAmount(product.sale_price, line.quantity))}</p>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between rounded-xl bg-brand-50 p-4">
            <span className="font-semibold text-brand-900">Total</span>
            <span className="text-xl font-extrabold tabular-nums text-brand-900">{formatFC(total)}</span>
          </div>
          <p className="text-sm text-slate-700">
            Paiement : <span className="font-semibold">{draft.payment ? PAYMENT_LABELS[draft.payment] : '—'}</span>
          </p>
          <p className="text-xs leading-relaxed text-slate-500">
            En confirmant, la vente est enregistrée et le stock est diminué. Une commande confirmée ne se supprime pas : elle peut seulement être annulée, avec restauration du stock.
          </p>
        </div>
      </Sheet>
    </div>
  );
}

function Stepper({ value, max, label, onChange }: { value: number; max: number; label: string; onChange: (q: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="inline-flex items-center rounded-xl bg-slate-100 p-1" role="group" aria-label={`Quantité de ${label}`}>
      <button type="button" onClick={() => onChange(value - 1)} aria-label="Diminuer" className="flex h-12 w-12 items-center justify-center rounded-lg bg-white text-2xl font-bold text-slate-800 shadow-sm active:scale-95">
        −
      </button>
      <input
        inputMode="numeric"
        aria-label={`Quantité pour ${label}`}
        value={text ?? String(value)}
        onFocus={(e) => {
          setText(String(value));
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
        onBlur={() => {
          if (text !== null) {
            const n = Number(text === '' ? 0 : text);
            setText(null);
            if (n !== value) onChange(n);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        className="h-12 w-14 bg-transparent text-center text-lg font-bold tabular-nums text-slate-900 focus:outline-none"
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label="Augmenter"
        className="flex h-12 w-12 items-center justify-center rounded-lg bg-brand-700 text-2xl font-bold text-white shadow-sm active:scale-95 disabled:bg-slate-300"
      >
        +
      </button>
    </div>
  );
}
