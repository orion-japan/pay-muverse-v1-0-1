-- Grant Sofia credit by user_code
-- Used by Master Partner monthly credit grant.
-- 正本: public.users.sofia_credit

create or replace function public.grant_sofia_credit_by_user_code(
  p_user_code text,
  p_amount integer,
  p_reason text default 'manual_sofia_grant',
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
as $function$
declare
  v_tx_id uuid := gen_random_uuid();
  v_key text;
begin
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  v_key := coalesce(p_idempotency_key, 'sofia-grant-' || gen_random_uuid()::text);

  -- 冪等：同じキーなら二重付与しない
  if exists (
    select 1
    from public.credit_transactions
    where idempotency_key = v_key
  ) then
    return (
      select id
      from public.credit_transactions
      where idempotency_key = v_key
      limit 1
    );
  end if;

  -- 正本 sofia_credit に加算
  update public.users
     set sofia_credit = coalesce(sofia_credit, 0) + p_amount
   where user_code = p_user_code;

  if not found then
    raise exception 'user not found: %', p_user_code;
  end if;

  -- 台帳
  insert into public.credit_transactions (
    id,
    user_id,
    user_code,
    delta,
    reason,
    idempotency_key,
    meta,
    created_at
  )
  values (
    v_tx_id,
    null,
    p_user_code,
    p_amount,
    p_reason,
    v_key,
    jsonb_build_object(
      'credit_source', 'sofia_credit',
      'grant_kind', 'master_partner_monthly'
    ),
    now()
  );

  return v_tx_id;
end
$function$;
