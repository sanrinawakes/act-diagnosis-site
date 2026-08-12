-- AWAKES access is time-limited. MyASP's 2099 payment expiry is not an
-- entitlement to ACTI, so ACTI keeps its own membership term and fails closed
-- when the term is missing or expired.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS awakes_access_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS awakes_access_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS awakes_access_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS awakes_access_source text,
  ADD COLUMN IF NOT EXISTS awakes_expired_at timestamptz;

ALTER TABLE public.pending_activations
  ADD COLUMN IF NOT EXISTS access_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS access_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_event_id text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_subscription_status_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_status_check
  CHECK (subscription_status IN ('none', 'active', 'expired', 'cancelled', 'payment_failed'));

CREATE INDEX IF NOT EXISTS idx_profiles_awakes_access_expiry
  ON public.profiles(awakes_access_expires_at)
  WHERE subscription_status = 'active' AND is_active = true;

CREATE TABLE IF NOT EXISTS public.awakes_memberships (
  email text PRIMARY KEY CHECK (email = lower(trim(email))),
  started_at timestamptz NOT NULL,
  renewal_cycle integer NOT NULL DEFAULT 0 CHECK (renewal_cycle >= 0),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'cancelled')),
  source text NOT NULL,
  last_event_id text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > started_at)
);

CREATE INDEX IF NOT EXISTS idx_awakes_memberships_expiry
  ON public.awakes_memberships(expires_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.awakes_membership_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(trim(email))),
  event_type text NOT NULL CHECK (event_type IN ('initial', 'renewal', 'legacy_import')),
  renewal_cycle integer NOT NULL CHECK (renewal_cycle >= 0),
  source text NOT NULL,
  external_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  resulting_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_event_id)
);

CREATE TABLE IF NOT EXISTS public.awakes_access_cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  memberships_expired integer NOT NULL DEFAULT 0 CHECK (memberships_expired >= 0),
  profiles_deactivated integer NOT NULL DEFAULT 0 CHECK (profiles_deactivated >= 0),
  pending_revoked integer NOT NULL DEFAULT 0 CHECK (pending_revoked >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awakes_access_cron_runs_created_at
  ON public.awakes_access_cron_runs(created_at DESC);

-- A customer can buy the same renewal form twice. Only one renewal is allowed
-- for a given membership year, even if MyASP produces two different order IDs.
CREATE UNIQUE INDEX IF NOT EXISTS awakes_membership_events_cycle_unique
  ON public.awakes_membership_events(email, renewal_cycle)
  WHERE event_type = 'renewal';

ALTER TABLE public.awakes_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.awakes_membership_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.awakes_access_cron_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.awakes_memberships FROM anon, authenticated;
REVOKE ALL ON TABLE public.awakes_membership_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.awakes_access_cron_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.awakes_memberships TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.awakes_membership_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.awakes_access_cron_runs TO service_role;

CREATE OR REPLACE FUNCTION public.apply_awakes_membership_event(
  p_email text,
  p_event_type text,
  p_external_event_id text,
  p_occurred_at timestamptz,
  p_renewal_cycle integer,
  p_source text
)
RETURNS TABLE (status text, access_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_membership public.awakes_memberships%ROWTYPE;
  v_started_at timestamptz;
  v_expires_at timestamptz;
  v_cycle integer;
  v_event_id uuid;
  v_membership_found boolean;
BEGIN
  IF v_email = '' OR position('@' IN v_email) <= 1 THEN
    RAISE EXCEPTION 'A valid email is required';
  END IF;
  IF p_event_type NOT IN ('initial', 'renewal', 'legacy_import') THEN
    RAISE EXCEPTION 'Unsupported AWAKES membership event type';
  END IF;
  IF coalesce(length(trim(p_external_event_id)), 0) = 0
     OR length(p_external_event_id) > 200 THEN
    RAISE EXCEPTION 'A valid external event ID is required';
  END IF;
  IF coalesce(length(trim(p_source)), 0) = 0 OR length(p_source) > 100 THEN
    RAISE EXCEPTION 'A valid event source is required';
  END IF;
  IF p_occurred_at IS NULL OR p_occurred_at > now() + interval '1 day' THEN
    RAISE EXCEPTION 'A valid event time is required';
  END IF;
  IF p_renewal_cycle < 0 OR p_renewal_cycle > 100 THEN
    RAISE EXCEPTION 'Renewal cycle is out of range';
  END IF;
  IF p_event_type = 'renewal' AND p_renewal_cycle < 1 THEN
    RAISE EXCEPTION 'Renewal events require a positive cycle';
  END IF;

  SELECT * INTO v_membership
  FROM public.awakes_memberships
  WHERE email = v_email
  FOR UPDATE;
  v_membership_found := FOUND;

  -- A retried initial payment or a bulk import must never recreate a pending
  -- entitlement after an explicit cancellation/payment failure. Only a new,
  -- identified renewal event may re-open that membership.
  IF p_event_type <> 'renewal' AND (
    v_membership.status = 'cancelled'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE (lower(myasp_customer_email) = v_email
          OR (p_event_type = 'legacy_import' AND lower(email) = v_email))
        AND subscription_status IN ('cancelled', 'payment_failed')
    )
  ) THEN
    RETURN QUERY SELECT 'account_not_eligible'::text, v_membership.expires_at;
    RETURN;
  END IF;

  IF v_membership_found THEN
    v_started_at := v_membership.started_at;
    IF p_event_type = 'renewal' THEN
      v_cycle := greatest(v_membership.renewal_cycle, p_renewal_cycle);
      v_expires_at := v_started_at + make_interval(years => v_cycle + 1);
    ELSE
      -- Retried initial-payment notifications must not extend access.
      v_cycle := v_membership.renewal_cycle;
      v_expires_at := v_membership.expires_at;
    END IF;
  ELSE
    IF p_event_type = 'renewal' THEN
      RETURN QUERY SELECT 'membership_missing'::text, NULL::timestamptz;
      RETURN;
    END IF;
    v_started_at := p_occurred_at;
    v_cycle := p_renewal_cycle;
    v_expires_at := v_started_at + make_interval(years => v_cycle + 1);
  END IF;

  INSERT INTO public.awakes_membership_events (
    email, event_type, renewal_cycle, source, external_event_id,
    occurred_at, resulting_expires_at
  ) VALUES (
    v_email, p_event_type, p_renewal_cycle, trim(p_source),
    trim(p_external_event_id), p_occurred_at, v_expires_at
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN QUERY SELECT 'duplicate'::text, v_expires_at;
    RETURN;
  END IF;

  INSERT INTO public.awakes_memberships (
    email, started_at, renewal_cycle, expires_at, status, source,
    last_event_id, verified_at, updated_at
  ) VALUES (
    v_email, v_started_at, v_cycle, v_expires_at,
    CASE WHEN v_expires_at > now() THEN 'active' ELSE 'expired' END,
    trim(p_source), trim(p_external_event_id), now(), now()
  )
  ON CONFLICT (email) DO UPDATE SET
    renewal_cycle = excluded.renewal_cycle,
    expires_at = excluded.expires_at,
    status = excluded.status,
    source = excluded.source,
    last_event_id = excluded.last_event_id,
    verified_at = excluded.verified_at,
    updated_at = now();

  INSERT INTO public.pending_activations (
    email, source, access_started_at, access_expires_at, external_event_id
  ) VALUES (
    v_email, trim(p_source), v_started_at, v_expires_at, trim(p_external_event_id)
  )
  ON CONFLICT (email) DO UPDATE SET
    source = excluded.source,
    access_started_at = excluded.access_started_at,
    access_expires_at = excluded.access_expires_at,
    external_event_id = excluded.external_event_id;

  -- Existing linked accounts can be refreshed by a verified renewal. An
  -- initial/import event never revives a cancellation or payment failure.
  UPDATE public.profiles
  SET
    myasp_customer_email = coalesce(myasp_customer_email, v_email),
    awakes_access_started_at = v_started_at,
    awakes_access_expires_at = v_expires_at,
    awakes_access_updated_at = now(),
    awakes_access_source = trim(p_source),
    awakes_expired_at = CASE WHEN v_expires_at <= now() THEN now() ELSE NULL END,
    subscription_status = CASE
      WHEN role = 'admin' THEN subscription_status
      WHEN v_expires_at <= now() THEN 'expired'
      WHEN p_event_type = 'renewal' THEN 'active'
      WHEN subscription_status IN ('cancelled', 'payment_failed') THEN subscription_status
      ELSE 'active'
    END,
    is_active = CASE
      WHEN role = 'admin' THEN is_active
      WHEN v_expires_at <= now() THEN false
      WHEN p_event_type = 'renewal' THEN true
      WHEN subscription_status IN ('cancelled', 'payment_failed') THEN is_active
      ELSE true
    END,
    subscribed_at = coalesce(subscribed_at, v_started_at),
    updated_at = now()
  WHERE lower(myasp_customer_email) = v_email
     OR (p_event_type = 'legacy_import' AND lower(email) = v_email);

  RETURN QUERY SELECT 'applied'::text, v_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_awakes_membership_event(text, text, text, timestamptz, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_awakes_membership_event(text, text, text, timestamptz, integer, text)
  TO service_role;

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

-- Replace the claim RPC so an expired or undated pending record can never
-- activate an account.
CREATE OR REPLACE FUNCTION public.consume_verified_subscription_claim(
  p_user_id uuid,
  p_awakes_email text,
  p_code_hash text,
  p_max_attempts integer
)
RETURNS TABLE (status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challenge public.subscription_claim_challenges%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_pending public.pending_activations%ROWTYPE;
BEGIN
  IF p_max_attempts < 1 THEN RAISE EXCEPTION 'Subscription claim attempt limit must be positive'; END IF;

  SELECT * INTO v_challenge FROM public.subscription_claim_challenges
  WHERE user_id = p_user_id AND awakes_email = lower(trim(p_awakes_email)) FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'challenge_missing'; RETURN; END IF;
  IF v_challenge.consumed_at IS NOT NULL THEN RETURN QUERY SELECT 'already_consumed'; RETURN; END IF;
  IF v_challenge.expires_at <= now() THEN RETURN QUERY SELECT 'expired'; RETURN; END IF;
  IF v_challenge.attempts >= p_max_attempts THEN RETURN QUERY SELECT 'locked'; RETURN; END IF;
  IF v_challenge.code_hash <> p_code_hash THEN
    UPDATE public.subscription_claim_challenges SET attempts = attempts + 1, updated_at = now()
    WHERE user_id = p_user_id AND awakes_email = lower(trim(p_awakes_email));
    RETURN QUERY SELECT 'invalid_code'; RETURN;
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'profile_missing'; RETURN; END IF;
  IF v_profile.subscription_status = 'active'
     AND v_profile.is_active
     AND v_profile.awakes_access_expires_at > now() THEN
    UPDATE public.subscription_claim_challenges SET consumed_at = now(), updated_at = now()
    WHERE user_id = p_user_id AND awakes_email = lower(trim(p_awakes_email));
    RETURN QUERY SELECT 'already_active'; RETURN;
  END IF;
  IF v_profile.subscription_status IN ('cancelled', 'payment_failed') THEN
    RETURN QUERY SELECT 'account_not_eligible'; RETURN;
  END IF;

  SELECT * INTO v_pending FROM public.pending_activations
  WHERE email = lower(trim(p_awakes_email)) FOR UPDATE;
  IF NOT FOUND OR v_pending.activated OR v_pending.access_expires_at IS NULL
     OR v_pending.access_expires_at <= now() THEN
    RETURN QUERY SELECT 'payment_not_eligible'; RETURN;
  END IF;

  UPDATE public.profiles SET
    subscription_status = 'active', is_active = true,
    subscribed_at = coalesce(subscribed_at, v_pending.access_started_at, now()),
    myasp_customer_email = lower(trim(p_awakes_email)),
    awakes_access_started_at = v_pending.access_started_at,
    awakes_access_expires_at = v_pending.access_expires_at,
    awakes_access_updated_at = now(), awakes_access_source = v_pending.source,
    awakes_expired_at = NULL, updated_at = now()
  WHERE id = p_user_id;

  UPDATE public.pending_activations SET activated = true, activated_at = now()
  WHERE email = lower(trim(p_awakes_email)) AND activated = false;
  UPDATE public.subscription_claim_challenges SET consumed_at = now(), updated_at = now()
  WHERE user_id = p_user_id AND awakes_email = lower(trim(p_awakes_email));
  RETURN QUERY SELECT 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.consume_verified_subscription_claim(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_verified_subscription_claim(uuid, text, text, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
