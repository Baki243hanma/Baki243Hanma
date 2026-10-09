import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReady } from '../app/useReady';
import { createProduct, updateProduct } from '../db/repo';
import { DEFAULT_CATEGORIES } from '../domain/types';
import { validateProduct, type FieldErrors, type ProductFormValues } from '../domain/validation';
import { Banner, Button, Card, Field, PageHeader, Spinner, TextInput } from '../components/ui';
import { IconBack } from '../components/icons';
import { useToast } from '../components/Toast';
import { useAsyncAction } from '../components/Confirm';
import { formatFC, parseAmount, percentOf, formatInt } from '../lib/money';

interface RawForm {
  name: string;
  category: string;
  purchase_price: string;
  sale_price: string;
  alert_threshold: string;
  initial_quantity: string;
}

const EMPTY: RawForm = { name: '', category: '', purchase_price: '', sale_price: '', alert_threshold: '3', initial_quantity: '0' };

function toValues(raw: RawForm): { values: ProductFormValues; invalid: FieldErrors<keyof RawForm> } {
  const invalid: FieldErrors<keyof RawForm> = {};
  const parse = (key: keyof RawForm, value: string, required = true): number => {
    if (value.trim() === '' && !required) return 0;
    const n = parseAmount(value);
    if (n === null) {
      invalid[key] = 'Entrez un nombre entier (sans virgule).';
      return 0;
    }
    return n;
  };
  const values: ProductFormValues = {
    name: raw.name,
    category: raw.category.trim() || null,
    purchase_price: parse('purchase_price', raw.purchase_price, false),
    sale_price: parse('sale_price', raw.sale_price),
    alert_threshold: parse('alert_threshold', raw.alert_threshold, false),
    initial_quantity: parse('initial_quantity', raw.initial_quantity, false),
  };
  return { values, invalid };
}

export function ProductFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { db, shop } = useReady();
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const existing = useLiveQuery(
    async () => (mode === 'edit' && id ? (await db.products.get(id)) ?? null : null),
    [db, id, mode],
    undefined,
  );

  const [raw, setRaw] = useState<RawForm>(EMPTY);
  const [hydrated, setHydrated] = useState(mode === 'create');
  const [touched, setTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors<keyof RawForm>>({});
  const { busy, run } = useAsyncAction();

  useEffect(() => {
    if (mode === 'edit' && existing && !hydrated) {
      setRaw({
        name: existing.name,
        category: existing.category ?? '',
        purchase_price: String(existing.purchase_price),
        sale_price: String(existing.sale_price),
        alert_threshold: String(existing.alert_threshold),
        initial_quantity: String(existing.quantity),
      });
      setHydrated(true);
    }
  }, [existing, hydrated, mode]);

  const parsed = useMemo(() => toValues(raw), [raw]);
  const preview = useMemo(() => {
    const sale = parsed.values.sale_price;
    const buy = parsed.values.purchase_price;
    const margin = sale - buy;
    return { margin, percent: sale > 0 ? percentOf(margin, sale) : 0 };
  }, [parsed]);

  if (mode === 'edit' && existing === undefined) return <Spinner />;
  if (mode === 'edit' && existing === null) {
    return (
      <Banner tone="danger" title="Article introuvable">
        <Link to="/articles" className="font-semibold underline">Retour à la liste</Link>
      </Banner>
    );
  }

  function update<K extends keyof RawForm>(key: K, value: string) {
    setRaw((r) => ({ ...r, [key]: value }));
    setTouched(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const { values, invalid } = toValues(raw);
    const { errors: validation } = validateProduct(values, mode);
    const merged: FieldErrors<keyof RawForm> = { ...invalid, ...(validation as FieldErrors<keyof RawForm>) };
    setErrors(merged);
    if (Object.keys(merged).length > 0) {
      setFormError('Corrigez les champs en rouge pour continuer.');
      return;
    }
    await run(async () => {
      if (mode === 'create') {
        const product = await createProduct(db, shop.id, values);
        toast.show('Article créé.', 'success');
        navigate(`/articles/${product.id}`, { replace: true });
      } else if (id) {
        await updateProduct(db, id, values);
        toast.show('Article modifié.', 'success');
        navigate(`/articles/${id}`, { replace: true });
      }
    }, (msg) => setFormError(msg));
  }

  const showErr = (key: keyof RawForm) => (touched || Object.keys(errors).length > 0 ? errors[key] : undefined);

  return (
    <div className="flex flex-col gap-5">
      <Link to={mode === 'edit' && id ? `/articles/${id}` : '/articles'} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand-800">
        <IconBack size={18} /> Retour
      </Link>
      <PageHeader title={mode === 'create' ? 'Nouvel article' : 'Modifier l’article'} subtitle="Les champs marqués * sont obligatoires." />

      {formError && <Banner tone="danger">{formError}</Banner>}
      {parsed.values.sale_price > 0 && parsed.values.sale_price < parsed.values.purchase_price && (
        <Banner tone="warning">Attention : le prix de vente est inférieur au prix d’achat. Vous vendriez à perte.</Banner>
      )}

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <Card className="flex flex-col gap-5">
          <Field label="Nom de l’article" required error={showErr('name')} hint="Exemple : Brume corps vanille 200 ml">
            {(fid, desc) => (
              <TextInput id={fid} aria-describedby={desc} value={raw.name} onChange={(e) => update('name', e.target.value)} maxLength={120} error={!!showErr('name')} autoFocus={mode === 'create'} autoComplete="off" />
            )}
          </Field>

          <Field label="Catégorie" error={showErr('category')} hint="Choisissez dans la liste ou tapez une nouvelle catégorie.">
            {(fid, desc) => (
              <>
                <TextInput id={fid} aria-describedby={desc} list="categories" value={raw.category} onChange={(e) => update('category', e.target.value)} maxLength={60} autoComplete="off" />
                <datalist id="categories">
                  {DEFAULT_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            )}
          </Field>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Prix d’achat (FC)" error={showErr('purchase_price')} hint={parsed.values.purchase_price > 0 ? formatFC(parsed.values.purchase_price) : 'Coût payé au fournisseur.'}>
              {(fid, desc) => (
                <TextInput id={fid} aria-describedby={desc} inputMode="numeric" value={raw.purchase_price} onChange={(e) => update('purchase_price', e.target.value)} placeholder="0" error={!!showErr('purchase_price')} />
              )}
            </Field>
            <Field label="Prix de vente (FC)" required error={showErr('sale_price')} hint={parsed.values.sale_price > 0 ? formatFC(parsed.values.sale_price) : 'Prix affiché à la caisse.'}>
              {(fid, desc) => (
                <TextInput id={fid} aria-describedby={desc} inputMode="numeric" value={raw.sale_price} onChange={(e) => update('sale_price', e.target.value)} placeholder="0" error={!!showErr('sale_price')} />
              )}
            </Field>
          </div>

          {parsed.values.sale_price > 0 && (
            <div className="rounded-xl bg-brand-50 p-3 text-sm text-brand-900">
              Marge par article : <span className="font-bold">{formatFC(preview.margin)}</span> ({preview.percent} %)
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {mode === 'create' && (
              <Field label="Quantité en stock" required error={showErr('initial_quantity')} hint="Nombre d’articles que vous avez actuellement.">
                {(fid, desc) => (
                  <TextInput id={fid} aria-describedby={desc} inputMode="numeric" value={raw.initial_quantity} onChange={(e) => update('initial_quantity', e.target.value)} error={!!showErr('initial_quantity')} />
                )}
              </Field>
            )}
            <Field label="Alerte de stock faible à" error={showErr('alert_threshold')} hint="Vous serez alerté quand il reste ce nombre ou moins.">
              {(fid, desc) => (
                <TextInput id={fid} aria-describedby={desc} inputMode="numeric" value={raw.alert_threshold} onChange={(e) => update('alert_threshold', e.target.value)} error={!!showErr('alert_threshold')} />
              )}
            </Field>
          </div>

          {mode === 'edit' && existing && (
            <p className="text-sm text-slate-600">
              Stock actuel : <span className="font-semibold">{formatInt(existing.quantity)}</span>. Pour modifier la quantité, utilisez « Entrée de stock » ou « Corriger le stock » sur la fiche de l’article.
            </p>
          )}
        </Card>

        <div className="sticky bottom-24 z-10 flex flex-col gap-2 sm:static">
          <Button type="submit" block disabled={busy || !hydrated}>
            {busy ? 'Enregistrement…' : mode === 'create' ? 'Enregistrer l’article' : 'Enregistrer les modifications'}
          </Button>
          <Button variant="secondary" block onClick={() => navigate(-1)} disabled={busy}>
            Annuler
          </Button>
        </div>
      </form>
    </div>
  );
}

