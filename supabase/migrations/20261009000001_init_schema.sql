-- =============================================================================
-- ShopFlow RDC - Migration 0001 : schéma initial
-- Montants : entiers en FC (bigint). Quantités : entiers. Aucun flottant.
-- Les écritures passent par public.apply_sync_operation (voir migration 0003).
-- =============================================================================

-- Boutiques : une boutique par compte propriétaire dans le MVP.
create table if not exists public.shops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  currency    text not null default 'FC' check (currency = 'FC'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Profil de boutique : relie un utilisateur Supabase Auth à sa boutique.
create table if not exists public.shop_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete restrict,
  role        text not null default 'owner' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now()
);
create index if not exists shop_profiles_shop_idx on public.shop_profiles(shop_id);

-- Articles. quantity = stock courant (toujours modifié via stock_movements).
create table if not exists public.products (
  id              uuid primary key,
  shop_id         uuid not null references public.shops(id) on delete restrict,
  name            text not null check (char_length(btrim(name)) between 1 and 160),
  category        text check (category is null or char_length(category) <= 60),
  purchase_price  bigint not null check (purchase_price >= 0),
  sale_price      bigint not null check (sale_price > 0),
  quantity        integer not null default 0 check (quantity >= 0),
  alert_threshold integer not null default 0 check (alert_threshold >= 0),
  status          text not null default 'active' check (status in ('active', 'archived')),
  version         integer not null default 1 check (version >= 1),
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  archived_at     timestamptz,
  received_at     timestamptz not null default now(),
  constraint products_archived_consistency check ((status = 'archived') = (archived_at is not null))
);
create index if not exists products_shop_idx on public.products(shop_id);

-- Commandes. Jamais supprimées : une annulation change seulement le statut.
create table if not exists public.orders (
  id              uuid primary key,
  shop_id         uuid not null references public.shops(id) on delete restrict,
  status          text not null check (status in ('confirmed', 'cancelled')),
  payment_method  text not null check (payment_method in ('cash', 'mobile_money', 'other')),
  total_amount    bigint not null check (total_amount >= 0),
  total_cost      bigint not null check (total_cost >= 0),
  gross_margin    bigint generated always as (total_amount - total_cost) stored,
  total_quantity  integer not null check (total_quantity > 0),
  created_at      timestamptz not null,
  cancelled_at    timestamptz,
  cancel_reason   text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  updated_at      timestamptz not null,
  received_at     timestamptz not null default now(),
  constraint orders_cancel_consistency check ((status = 'cancelled') = (cancelled_at is not null))
);
create index if not exists orders_shop_created_idx on public.orders(shop_id, created_at);

-- Lignes de commande : snapshot du nom, du prix de vente et du coût unitaire.
create table if not exists public.order_items (
  id            uuid primary key,
  order_id      uuid not null references public.orders(id) on delete restrict,
  shop_id       uuid not null references public.shops(id) on delete restrict,
  product_id    uuid not null references public.products(id) on delete restrict,
  product_name  text not null check (char_length(btrim(product_name)) between 1 and 160),
  unit_price    bigint not null check (unit_price > 0),
  unit_cost     bigint not null check (unit_cost >= 0),
  quantity      integer not null check (quantity > 0),
  line_total    bigint generated always as (unit_price * quantity) stored,
  line_cost     bigint generated always as (unit_cost * quantity) stored,
  constraint order_items_one_line_per_product unique (order_id, product_id)
);
create index if not exists order_items_order_idx on public.order_items(order_id);

-- Mouvements de stock : explique chaque changement de quantité.
create table if not exists public.stock_movements (
  id              uuid primary key,
  shop_id         uuid not null references public.shops(id) on delete restrict,
  product_id      uuid not null references public.products(id) on delete restrict,
  order_id        uuid references public.orders(id) on delete restrict,
  type            text not null check (type in ('initial', 'entry', 'sale', 'cancel_restock', 'correction')),
  quantity_delta  integer not null check (quantity_delta <> 0),
  quantity_after  integer not null check (quantity_after >= 0),
  reason          text check (reason is null or char_length(reason) <= 300),
  created_at      timestamptz not null,
  received_at     timestamptz not null default now(),
  constraint movements_order_link check ((type in ('sale', 'cancel_restock')) = (order_id is not null)),
  constraint movements_sign check (
    (type in ('initial', 'entry', 'cancel_restock') and quantity_delta > 0)
    or (type = 'sale' and quantity_delta < 0)
    or (type = 'correction')
  )
);
create index if not exists stock_movements_product_idx on public.stock_movements(product_id, created_at);
create index if not exists stock_movements_order_idx on public.stock_movements(order_id);

-- Journal des opérations appliquées : garantit l'idempotence (même op_id = même résultat).
create table if not exists public.remote_operations (
  op_id        uuid primary key,
  shop_id      uuid not null references public.shops(id) on delete restrict,
  op_type      text not null,
  result       jsonb not null,
  received_at  timestamptz not null default now()
);
