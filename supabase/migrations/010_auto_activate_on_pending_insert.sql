-- Auto-activate matching profiles when pending_activations gets a new email
-- Plus one-time fix for any currently-stuck users (ACTI-first / AWAKES-later flow)
--
-- IMPORTANT: This migration only touches profiles whose subscription_status is
-- 'none' or NULL. Users in 'cancelled' or 'payment_failed' state are left alone
-- (they must be re-activated manually if they re-subscribe).

-- ========== One-time fix: rescue currently stuck users ==========
update public.profiles p
set 
  subscription_status = 'active',
  is_active = true,
  subscribed_at = coalesce(p.subscribed_at, now()),
  myasp_customer_email = coalesce(p.myasp_customer_email, lower(p.email)),
  updated_at = now()
from public.pending_activations pa
where lower(pa.email) = lower(p.email)
  and (p.subscription_status = 'none' or p.subscription_status is null);

update public.pending_activations pa
set activated = true, activated_at = now()
from public.profiles p
where lower(pa.email) = lower(p.email)
  and p.subscription_status = 'active'
  and pa.activated = false;

-- ========== New trigger: handle ACTI-first then AWAKES-later flow ==========
create or replace function public.handle_pending_activation_insert()
returns trigger as $$
begin
  update public.profiles
  set 
    subscription_status = 'active',
    is_active = true,
    subscribed_at = coalesce(subscribed_at, now()),
    myasp_customer_email = coalesce(myasp_customer_email, lower(email)),
    updated_at = now()
  where lower(email) = lower(NEW.email)
    and (subscription_status = 'none' or subscription_status is null);
  
  if found then
    NEW.activated := true;
    NEW.activated_at := now();
  end if;
  
  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists trigger_pending_activation_insert on public.pending_activations;
create trigger trigger_pending_activation_insert
  before insert on public.pending_activations
  for each row
  execute function public.handle_pending_activation_insert();

notify pgrst, 'reload schema';
