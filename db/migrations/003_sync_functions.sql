-- =============================================================================
-- ShopFlow RDC - Migration 0003 : fonctions de synchronisation
--
-- Point d'entrée unique : public.apply_sync_operation(op_id, op_type, payload).
--  - Une opération = une transaction (commande + lignes + stock + mouvements).
--  - Idempotence : une opération déjà appliquée (même op_id) renvoie son résultat
--    enregistré, sans rien réécrire.
--  - Résultats métier (stock insuffisant, conflit de version...) : renvoyés en
--    JSON avec status = 'failed' ou 'conflict', SANS aucune écriture.
--  - Erreurs techniques : exception -> rollback complet côté client.
--  - Les totaux sont recalculés côté serveur à partir des lignes ; le client
--    n'est pas cru sur les totaux.
-- =============================================================================

-- Crée la boutique de l'utilisateur courant si elle n'existe pas encore.
create or replace function public.ensure_shop(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid text := public.current_user_id();
  v_shop public.shops%rowtype;
  v_shop_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select s.* into v_shop
  from public.shop_profiles sp
  join public.shops s on s.id = sp.shop_id
  where sp.user_id = v_uid;

  if found then
    return jsonb_build_object('id', v_shop.id, 'name', v_shop.name, 'created', false);
  end if;

  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'shop_name_required' using errcode = '22023';
  end if;

  insert into public.shops (name) values (btrim(p_name)) returning id into v_shop_id;
  insert into public.shop_profiles (user_id, shop_id, role) values (v_uid, v_shop_id, 'owner');

  return jsonb_build_object('id', v_shop_id, 'name', btrim(p_name), 'created', true);
end;
$$;

-- Création d'une commande : valide tout, puis écrit commande, lignes et stock
-- (le tout dans la transaction de l'appel RPC). Retourne une erreur métier sans écrire.
create or replace function public.op_create_order(p_op_id uuid, p_shop_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o            jsonb := p_payload -> 'order';
  v_order_id   uuid;
  v_created    timestamptz;
  v_pay        text;
  it           jsonb;
  v_pid        uuid;
  v_qty        integer;
  v_price      bigint;
  v_cost       bigint;
  v_name       text;
  v_product    public.products%rowtype;
  v_seen       uuid[] := '{}';
  v_total      bigint := 0;
  v_cost_total bigint := 0;
  v_qty_total  bigint := 0;
  v_count      integer := 0;
begin
  if o is null or jsonb_typeof(o) <> 'object' then
    return jsonb_build_object('status', 'failed', 'code', 'invalid_payload');
  end if;

  v_order_id := (o ->> 'id')::uuid;
  v_created  := (o ->> 'created_at')::timestamptz;
  v_pay      := o ->> 'payment_method';

  if exists (select 1 from public.orders where id = v_order_id) then
    return jsonb_build_object('status', 'already_applied', 'order_id', v_order_id);
  end if;

  if v_pay not in ('cash', 'mobile_money', 'other') then
    return jsonb_build_object('status', 'failed', 'code', 'invalid_payment_method');
  end if;

  if jsonb_typeof(p_payload -> 'items') <> 'array' or jsonb_array_length(p_payload -> 'items') = 0 then
    return jsonb_build_object('status', 'failed', 'code', 'empty_order');
  end if;

  -- Passe 1 : validation, verrouillage des articles, calcul des totaux (aucune écriture).
  for it in select value from jsonb_array_elements(p_payload -> 'items') loop
    v_pid   := (it ->> 'product_id')::uuid;
    v_qty   := (it ->> 'quantity')::integer;
    v_price := (it ->> 'unit_price')::bigint;
    v_cost  := (it ->> 'unit_cost')::bigint;

    if v_pid = any(v_seen) then
      return jsonb_build_object('status', 'failed', 'code', 'duplicate_product_line', 'product_id', v_pid);
    end if;
    v_seen := v_seen || v_pid;

    if v_qty is null or v_qty <= 0 then
      return jsonb_build_object('status', 'failed', 'code', 'invalid_quantity', 'product_id', v_pid);
    end if;
    if v_price is null or v_price <= 0 or v_cost is null or v_cost < 0 then
      return jsonb_build_object('status', 'failed', 'code', 'invalid_price', 'product_id', v_pid);
    end if;

    select * into v_product
    from public.products
    where id = v_pid and shop_id = p_shop_id
    for update;

    if not found then
      return jsonb_build_object('status', 'failed', 'code', 'product_not_found', 'product_id', v_pid);
    end if;

    if v_product.quantity < v_qty then
      return jsonb_build_object(
        'status', 'failed',
        'code', 'insufficient_stock',
        'product_id', v_pid,
        'product_name', v_product.name,
        'available', v_product.quantity,
        'requested', v_qty
      );
    end if;

    v_total      := v_total + v_price * v_qty;
    v_cost_total := v_cost_total + v_cost * v_qty;
    v_qty_total  := v_qty_total + v_qty;
    v_count      := v_count + 1;
  end loop;

  -- Passe 2 : écritures (dans la même transaction que l'appel RPC).
  insert into public.orders (
    id, shop_id, status, payment_method, total_amount, total_cost, total_quantity, created_at, updated_at
  ) values (
    v_order_id, p_shop_id, 'confirmed', v_pay, v_total, v_cost_total, v_qty_total::integer, v_created, v_created
  );

  for it in select value from jsonb_array_elements(p_payload -> 'items') loop
    v_pid   := (it ->> 'product_id')::uuid;
    v_qty   := (it ->> 'quantity')::integer;
    v_price := (it ->> 'unit_price')::bigint;
    v_cost  := (it ->> 'unit_cost')::bigint;
    v_name  := it ->> 'product_name';

    insert into public.order_items (id, order_id, shop_id, product_id, product_name, unit_price, unit_cost, quantity)
    values ((it ->> 'id')::uuid, v_order_id, p_shop_id, v_pid, coalesce(nullif(btrim(v_name), ''), 'Article'), v_price, v_cost, v_qty);

    update public.products
    set quantity = quantity - v_qty, updated_at = greatest(updated_at, v_created)
    where id = v_pid
    returning * into v_product;

    insert into public.stock_movements (
      id, shop_id, product_id, order_id, type, quantity_delta, quantity_after, reason, created_at
    ) values (
      (it ->> 'movement_id')::uuid, p_shop_id, v_pid, v_order_id, 'sale', -v_qty, v_product.quantity, 'Vente', v_created
    );
  end loop;

  return jsonb_build_object(
    'status', 'applied',
    'order_id', v_order_id,
    'total_amount', v_total,
    'total_cost', v_cost_total,
    'gross_margin', v_total - v_cost_total,
    'total_quantity', v_qty_total,
    'line_count', v_count
  );
end;
$$;

-- Annulation : restaure le stock, conserve la commande d'origine.
create or replace function public.op_cancel_order(p_op_id uuid, p_shop_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id  uuid := (p_payload ->> 'order_id')::uuid;
  v_order     public.orders%rowtype;
  v_at        timestamptz := (p_payload ->> 'cancelled_at')::timestamptz;
  v_reason    text := btrim(coalesce(p_payload ->> 'reason', ''));
  it          record;
  v_product   public.products%rowtype;
begin
  select * into v_order
  from public.orders
  where id = v_order_id and shop_id = p_shop_id
  for update;

  if not found then
    return jsonb_build_object('status', 'failed', 'code', 'order_not_found', 'order_id', v_order_id);
  end if;

  if v_order.status = 'cancelled' then
    return jsonb_build_object('status', 'already_applied', 'order_id', v_order_id);
  end if;

  if char_length(v_reason) = 0 then
    return jsonb_build_object('status', 'failed', 'code', 'reason_required', 'order_id', v_order_id);
  end if;

  for it in
    select oi.product_id, oi.quantity
    from public.order_items oi
    where oi.order_id = v_order_id
    order by oi.product_id
  loop
    update public.products
    set quantity = quantity + it.quantity, updated_at = greatest(updated_at, v_at)
    where id = it.product_id and shop_id = p_shop_id
    returning * into v_product;

    insert into public.stock_movements (
      id, shop_id, product_id, order_id, type, quantity_delta, quantity_after, reason, created_at
    ) values (
      gen_random_uuid(), p_shop_id, it.product_id, v_order_id, 'cancel_restock', it.quantity,
      v_product.quantity, 'Annulation : ' || left(v_reason, 300), v_at
    );
  end loop;

  update public.orders
  set status = 'cancelled', cancelled_at = v_at, cancel_reason = left(v_reason, 300), updated_at = v_at
  where id = v_order_id;

  return jsonb_build_object('status', 'applied', 'order_id', v_order_id);
end;
$$;

-- Création / modification d'un article (champs catalogue uniquement, jamais le stock).
create or replace function public.op_upsert_product(p_op_id uuid, p_shop_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p          jsonb := p_payload -> 'product';
  v_id       uuid := (p ->> 'id')::uuid;
  v_base     integer := (p ->> 'base_version')::integer;
  v_row      public.products%rowtype;
  v_initial  integer := coalesce((p ->> 'initial_quantity')::integer, 0);
  v_status   text := p ->> 'status';
  v_archived timestamptz;
begin
  if v_base is null or v_base < 0 then
    return jsonb_build_object('status', 'failed', 'code', 'invalid_payload');
  end if;
  if v_status not in ('active', 'archived') then
    return jsonb_build_object('status', 'failed', 'code', 'invalid_status');
  end if;

  v_archived := case when v_status = 'archived' then (p ->> 'archived_at')::timestamptz else null end;

  select * into v_row from public.products where id = v_id for update;

  if not found then
    if v_base <> 0 then
      return jsonb_build_object('status', 'failed', 'code', 'product_not_found', 'product_id', v_id);
    end if;
    if v_initial < 0 then
      return jsonb_build_object('status', 'failed', 'code', 'invalid_quantity', 'product_id', v_id);
    end if;

    insert into public.products (
      id, shop_id, name, category, purchase_price, sale_price, quantity, alert_threshold,
      status, version, created_at, updated_at, archived_at
    ) values (
      v_id, p_shop_id, btrim(p ->> 'name'), nullif(btrim(coalesce(p ->> 'category', '')), ''),
      (p ->> 'purchase_price')::bigint, (p ->> 'sale_price')::bigint, v_initial,
      (p ->> 'alert_threshold')::integer, v_status, 1,
      (p ->> 'created_at')::timestamptz, (p ->> 'updated_at')::timestamptz, v_archived
    );

    if v_initial > 0 then
      insert into public.stock_movements (id, shop_id, product_id, type, quantity_delta, quantity_after, reason, created_at)
      values (
        coalesce((p ->> 'initial_movement_id')::uuid, gen_random_uuid()),
        p_shop_id, v_id, 'initial', v_initial, v_initial, 'Stock initial', (p ->> 'created_at')::timestamptz
      );
    end if;

    return jsonb_build_object('status', 'applied', 'product_id', v_id, 'version', 1);
  end if;

  if v_row.shop_id <> p_shop_id then
    return jsonb_build_object('status', 'failed', 'code', 'forbidden', 'product_id', v_id);
  end if;

  if v_row.version <> v_base then
    return jsonb_build_object(
      'status', 'conflict',
      'code', 'version_conflict',
      'product_id', v_id,
      'server_version', v_row.version,
      'server_product', jsonb_build_object(
        'id', v_row.id, 'name', v_row.name, 'category', v_row.category,
        'purchase_price', v_row.purchase_price, 'sale_price', v_row.sale_price,
        'quantity', v_row.quantity, 'alert_threshold', v_row.alert_threshold,
        'status', v_row.status, 'version', v_row.version
      )
    );
  end if;

  update public.products
  set name = btrim(p ->> 'name'),
      category = nullif(btrim(coalesce(p ->> 'category', '')), ''),
      purchase_price = (p ->> 'purchase_price')::bigint,
      sale_price = (p ->> 'sale_price')::bigint,
      alert_threshold = (p ->> 'alert_threshold')::integer,
      status = v_status,
      archived_at = v_archived,
      version = version + 1,
      updated_at = (p ->> 'updated_at')::timestamptz
  where id = v_id
  returning version into v_base;

  return jsonb_build_object('status', 'applied', 'product_id', v_id, 'version', v_base);
end;
$$;

-- Mouvement de stock manuel : entrée ou correction (jamais négatif).
create or replace function public.op_stock_movement(p_op_id uuid, p_shop_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m         jsonb := p_payload -> 'movement';
  v_id      uuid := (m ->> 'id')::uuid;
  v_pid     uuid := (m ->> 'product_id')::uuid;
  v_type    text := m ->> 'type';
  v_delta   integer := (m ->> 'delta')::integer;
  v_reason  text := nullif(btrim(coalesce(m ->> 'reason', '')), '');
  v_product public.products%rowtype;
  v_after   integer;
begin
  if v_type not in ('entry', 'correction') then
    return jsonb_build_object('status', 'failed', 'code', 'invalid_movement_type');
  end if;
  if v_delta is null or v_delta = 0 then
    return jsonb_build_object('status', 'failed', 'code', 'invalid_quantity', 'product_id', v_pid);
  end if;
  if v_type = 'entry' and v_delta < 0 then
    return jsonb_build_object('status', 'failed', 'code', 'invalid_quantity', 'product_id', v_pid);
  end if;
  if v_type = 'correction' and v_reason is null then
    return jsonb_build_object('status', 'failed', 'code', 'reason_required', 'product_id', v_pid);
  end if;

  select * into v_product from public.products where id = v_pid and shop_id = p_shop_id for update;
  if not found then
    return jsonb_build_object('status', 'failed', 'code', 'product_not_found', 'product_id', v_pid);
  end if;

  v_after := v_product.quantity + v_delta;
  if v_after < 0 then
    return jsonb_build_object(
      'status', 'failed', 'code', 'insufficient_stock', 'product_id', v_pid,
      'product_name', v_product.name, 'available', v_product.quantity, 'requested', -v_delta
    );
  end if;

  update public.products set quantity = v_after, updated_at = (m ->> 'created_at')::timestamptz
  where id = v_pid;

  insert into public.stock_movements (id, shop_id, product_id, type, quantity_delta, quantity_after, reason, created_at)
  values (v_id, p_shop_id, v_pid, v_type, v_delta, v_after, v_reason, (m ->> 'created_at')::timestamptz);

  return jsonb_build_object('status', 'applied', 'product_id', v_pid, 'quantity_after', v_after);
end;
$$;

-- Nom de la boutique (dernier écrit gagne, documenté).
create or replace function public.op_update_shop(p_op_id uuid, p_shop_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_payload ->> 'name', ''));
begin
  if char_length(v_name) = 0 or char_length(v_name) > 120 then
    return jsonb_build_object('status', 'failed', 'code', 'shop_name_invalid');
  end if;
  update public.shops set name = v_name, updated_at = now() where id = p_shop_id;
  return jsonb_build_object('status', 'applied', 'name', v_name);
end;
$$;

-- Point d'entrée unique utilisé par le client.
create or replace function public.apply_sync_operation(p_op_id uuid, p_op_type text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id  uuid;
  v_existing jsonb;
  v_result   jsonb;
begin
  if p_op_id is null or p_payload is null or p_op_type is null then
    raise exception 'invalid_operation' using errcode = '22023';
  end if;

  begin
    v_shop_id := (p_payload ->> 'shop_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'invalid_shop_id' using errcode = '22023';
  end;

  if v_shop_id is null or not public.is_shop_member(v_shop_id) then
    raise exception 'forbidden_shop' using errcode = '42501';
  end if;

  -- Sérialise les opérations d'une même boutique (cohérence du stock).
  perform pg_advisory_xact_lock(hashtextextended(v_shop_id::text, 0));

  select result into v_existing from public.remote_operations where op_id = p_op_id;
  if found then
    return v_existing || jsonb_build_object('duplicate', true);
  end if;

  case p_op_type
    when 'create_order'   then v_result := public.op_create_order(p_op_id, v_shop_id, p_payload);
    when 'cancel_order'   then v_result := public.op_cancel_order(p_op_id, v_shop_id, p_payload);
    when 'upsert_product' then v_result := public.op_upsert_product(p_op_id, v_shop_id, p_payload);
    when 'stock_movement' then v_result := public.op_stock_movement(p_op_id, v_shop_id, p_payload);
    when 'update_shop'    then v_result := public.op_update_shop(p_op_id, v_shop_id, p_payload);
    else raise exception 'unknown_operation_type' using errcode = '22023';
  end case;

  if v_result ->> 'status' in ('applied', 'already_applied') then
    insert into public.remote_operations (op_id, shop_id, op_type, result)
    values (p_op_id, v_shop_id, p_op_type, v_result);
  end if;

  return v_result;
end;
$$;

-- Droits d'exécution : les fonctions ne sont appelables que par le rôle propriétaire (le serveur api).
revoke all on function public.is_shop_member(uuid) from public;
revoke all on function public.ensure_shop(text) from public;
revoke all on function public.apply_sync_operation(uuid, text, jsonb) from public;
revoke all on function public.op_create_order(uuid, uuid, jsonb) from public;
revoke all on function public.op_cancel_order(uuid, uuid, jsonb) from public;
revoke all on function public.op_upsert_product(uuid, uuid, jsonb) from public;
revoke all on function public.op_stock_movement(uuid, uuid, jsonb) from public;
revoke all on function public.op_update_shop(uuid, uuid, jsonb) from public;

