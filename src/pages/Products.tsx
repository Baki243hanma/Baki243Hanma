import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReady } from '../app/useReady';
import { DEFAULT_CATEGORIES, type Product } from '../domain/types';
import { Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { IconPlus, IconSearch } from '../components/icons';
import { StockBadge } from '../components/status';
import { formatFC, formatInt } from '../lib/money';
import { isLowStock } from '../lib/calc';
import { matchesSearch } from '../lib/text';

export function ProductsPage() {
  const { db } = useReady();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('Toutes');
  const [showArchived, setShowArchived] = useState(false);

  const products = useLiveQuery(() => db.products.toArray(), [db], undefined);

  const categories = useMemo(() => {
    const set = new Set<string>(DEFAULT_CATEGORIES);
    for (const p of products ?? []) if (p.category) set.add(p.category);
    return ['Toutes', ...[...set].sort((a, b) => a.localeCompare(b, 'fr'))];
  }, [products]);

  const filtered = useMemo(() => {
    const list = (products ?? []).filter((p) => {
      if (!showArchived && p.status === 'archived') return false;
      if (category !== 'Toutes' && p.category !== category) return false;
      return matchesSearch(p.name, query);
    });
    return list.sort((a, b) => {
      const la = isLowStock(a) ? 0 : 1;
      const lb = isLowStock(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      return a.name.localeCompare(b.name, 'fr');
    });
  }, [products, query, category, showArchived]);

  const lowCount = (products ?? []).filter((p) => isLowStock(p)).length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Articles"
        subtitle={products ? `${products.filter((p) => p.status === 'active').length} article(s) actif(s)` : 'Chargement…'}
        action={
          <Link to="/articles/nouveau" className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-xl bg-brand-700 px-4 text-sm font-semibold text-white shadow-sm hover:bg-brand-800">
            <IconPlus size={18} /> Ajouter
          </Link>
        }
      />

      <label className="relative block">
        <span className="sr-only">Rechercher un article par nom</span>
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
            className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-semibold ${
              category === c ? 'bg-brand-700 text-white' : 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {lowCount > 0 ? (
          <Badge tone="warning">{lowCount} article(s) en stock faible</Badge>
        ) : (
          <span className="text-slate-500">Aucun stock faible</span>
        )}
        <label className="flex min-h-10 items-center gap-2 font-medium text-slate-700">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-5 w-5 accent-brand-700" />
          Afficher les archivés
        </label>
      </div>

      {products === undefined && <Spinner />}

      {products && products.length === 0 && (
        <EmptyState
          title="Aucun article pour l’instant"
          action={
            <Link to="/articles/nouveau" className="inline-flex min-h-12 items-center rounded-xl bg-brand-700 px-5 font-semibold text-white">
              Créer mon premier article
            </Link>
          }
        >
          Créez votre catalogue une seule fois : nom, prix d’achat, prix de vente et quantité en stock. Il servira ensuite à chaque commande.
        </EmptyState>
      )}

      {products && products.length > 0 && filtered.length === 0 && (
        <EmptyState title="Aucun article ne correspond">
          {query ? `Aucun résultat pour « ${query} »` : 'Aucun article dans cette catégorie'}. Essayez un autre mot ou une autre catégorie.
        </EmptyState>
      )}

      <ul className="flex flex-col gap-2.5">
        {filtered.map((p) => (
          <li key={p.id}>
            <ProductRow product={p} />
          </li>
        ))}
      </ul>

      {products && products.length > 0 && (
        <p className="text-center text-xs text-slate-500">
          Un article archivé n’est plus proposé à la vente, mais son historique est conservé.
        </p>
      )}
    </div>
  );
}

function ProductRow({ product }: { product: Product }) {
  return (
    <Link
      to={`/articles/${product.id}`}
      className={`flex min-h-20 items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition hover:ring-brand-300 active:scale-[0.99] ${product.status === 'archived' ? 'opacity-60' : ''}`}
    >
      <div className="min-w-0">
        <p className="truncate text-base font-semibold text-slate-900">{product.name}</p>
        <p className="truncate text-sm text-slate-500">
          {product.category ?? 'Sans catégorie'} · {formatFC(product.sale_price)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <StockBadge product={product} />
        <span className="text-sm font-bold tabular-nums text-slate-800">
          {formatInt(product.quantity)} en stock
        </span>
      </div>
    </Link>
  );
}
