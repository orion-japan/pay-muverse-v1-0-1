create or replace function public.consume_mu_screenshot_sofia_credit(
  p_user_code text,
  p_amount integer default 5
)
returns boolean
language plpgsql
security definer
as $$
begin
  update public.users
     set sofia_credit = sofia_credit - p_amount
   where user_code = p_user_code
     and sofia_credit >= p_amount;

  return found;
end;
$$;
