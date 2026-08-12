-- The paid coaching monitor is not a customer membership. Keep exactly one
-- service-only monitor profile separate from AWAKES customer entitlements.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_internal_coaching_monitor boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_single_internal_coaching_monitor
  ON public.profiles(is_internal_coaching_monitor)
  WHERE is_internal_coaching_monitor = true;

CREATE OR REPLACE FUNCTION public.protect_internal_coaching_monitor_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
    AND (
      (TG_OP = 'INSERT' AND NEW.is_internal_coaching_monitor = true)
      OR (
        TG_OP = 'UPDATE'
        AND NEW.is_internal_coaching_monitor IS DISTINCT FROM OLD.is_internal_coaching_monitor
      )
    )
  THEN
    RAISE EXCEPTION 'internal coaching monitor flag is service-managed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_internal_coaching_monitor_flag
  ON public.profiles;
CREATE TRIGGER protect_internal_coaching_monitor_flag
  BEFORE INSERT OR UPDATE OF is_internal_coaching_monitor ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_internal_coaching_monitor_flag();

CREATE OR REPLACE FUNCTION public.expire_awakes_memberships()
RETURNS TABLE (memberships_expired integer, profiles_deactivated integer, pending_revoked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_memberships integer := 0;
  v_profiles integer := 0;
  v_pending integer := 0;
BEGIN
  UPDATE public.awakes_memberships
  SET status = 'expired', updated_at = now()
  WHERE status = 'active' AND expires_at <= now();
  GET DIAGNOSTICS v_memberships = ROW_COUNT;

  UPDATE public.profiles
  SET
    subscription_status = 'expired',
    is_active = false,
    awakes_expired_at = coalesce(awakes_expired_at, now()),
    updated_at = now()
  WHERE role <> 'admin'
    AND is_internal_coaching_monitor = false
    AND subscription_status = 'active'
    AND is_active = true
    AND (awakes_access_expires_at IS NULL OR awakes_access_expires_at <= now());
  GET DIAGNOSTICS v_profiles = ROW_COUNT;

  DELETE FROM public.pending_activations
  WHERE access_expires_at IS NULL OR access_expires_at <= now();
  GET DIAGNOSTICS v_pending = ROW_COUNT;

  RETURN QUERY SELECT v_memberships, v_profiles, v_pending;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_awakes_memberships() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_awakes_memberships() TO service_role;

REVOKE ALL ON FUNCTION public.protect_internal_coaching_monitor_flag() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
