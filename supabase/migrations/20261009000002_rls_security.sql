-- =============================================================================
-- ShopFlow RDC - Migration 0002 : sécurité (RLS + droits)
-- Principe : lecture limitée à la boutique de l'utilisateur (RLS) ;
-- aucune écriture directe depuis le client ; toutes les écritures passent
-- par des fonctions SECURITY DEFINER qui vérifient l'appartenance à la boutique.
-- La clé service_role n'est JAMAIS utilisée par l'application.
-- =============================================================================

-- Vérifie que l'utilisateur courant appartient à la boutique donnée.
create or replace function public.is_shop_member(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.shop_profiles sp
    where sp.user_id = auth.uid()
      and sp.shop_id = p_shop_id
  );
$$;

-- Activer RLS sur toutes les tables.
alter table public.shops            enable row level security;
alter table public.shop_profiles    enable row level security;
alter table public.products         enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.remote_operations enable row level security;

-- Retirer tous les droits par défaut (Supabase accorde souvent des droits étendus).
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;

-- Lecture seule pour les utilisateurs connectés, limitée à leur boutique.
grant select on public.shops, public.shop_profiles, public.products, public.orders,
  public.order_items, public.stock_movements, public.remote_operations to authenticated;

create policy shops_select_member on public.shops
  for select to authenticated using (public.is_shop_member(id));

create policy shop_profiles_select_own on public.shop_profiles
  for select to authenticated using (user_id = auth.uid());

create policy products_select_member on public.products
  for select to authenticated using (public.is_shop_member(shop_id));

create policy orders_select_member on public.orders
  for select to authenticated using (public.is_shop_member(shop_id));

create policy order_items_select_member on public.order_items
  for select to authenticated using (public.is_shop_member(shop_id));

create policy stock_movements_select_member on public.stock_movements
  for select to authenticated using (public.is_shop_member(shop_id));

create policy remote_operations_select_member on public.remote_operations
  for select to authenticated using (public.is_shop_member(shop_id));

-- Aucune politique INSERT/UPDATE/DELETE pour authenticated : les écritures passent par les fonctions.
