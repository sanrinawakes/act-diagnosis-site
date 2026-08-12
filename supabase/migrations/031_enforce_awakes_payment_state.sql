-- AWAKES term validity and recurring-payment health are separate concerns.
-- A member can still be inside the one-year term while the latest recurring
-- charge has failed; ACTI must fail closed until MyASP reports a successful
-- retry. Every provider notification is recorded and ordered by occurred_at.

ALTER TABLE public.awakes_memberships
  DROP CONSTRAINT IF EXISTS awakes_memberships_status_check;
ALTER TABLE public.awakes_memberships
  ADD CONSTRAINT awakes_memberships_status_check
  CHECK (status IN ('active', 'expired', 'cancelled', 'payment_failed'));

ALTER TABLE public.awakes_memberships
  ADD COLUMN IF NOT EXISTS payment_state_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_payment_state_event_id text;

UPDATE public.awakes_memberships
SET payment_state_updated_at = coalesce(payment_state_updated_at, verified_at, updated_at)
WHERE payment_state_updated_at IS NULL;

CREATE TABLE IF NOT EXISTS public.awakes_payment_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(trim(email))),
  state text NOT NULL CHECK (state IN ('payment_failed', 'payment_restored')),
  source text NOT NULL,
  external_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  resulting_membership_status text NOT NULL
    CHECK (resulting_membership_status IN (
      'active', 'expired', 'cancelled', 'payment_failed', 'missing'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_awakes_payment_state_events_email_time
  ON public.awakes_payment_state_events(email, occurred_at DESC);

ALTER TABLE public.awakes_payment_state_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.awakes_payment_state_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.awakes_payment_state_events TO service_role;

-- Keep the event-driven term function from migration 030, but put a small
-- guard in front of it. An initial-payment retry must never reopen a member
-- whose later recurring charge failed. A new paid annual renewal is allowed.
ALTER FUNCTION public.apply_awakes_membership_event(
  text, text, text, timestamptz, integer, text
) RENAME TO apply_awakes_membership_event_v030;

REVOKE ALL ON FUNCTION public.apply_awakes_membership_event_v030(
  text, text, text, timestamptz, integer, text
) FROM PUBLIC, anon, authenticated, service_role;

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
  v_current_status text;
  v_result_status text;
  v_result_expires_at timestamptz;
BEGIN
  SELECT m.status INTO v_current_status
  FROM public.awakes_memberships m
  WHERE m.email = v_email;

  IF p_event_type <> 'renewal' AND v_current_status = 'payment_failed' THEN
    SELECT m.expires_at INTO v_result_expires_at
    FROM public.awakes_memberships m
    WHERE m.email = v_email;
    RETURN QUERY SELECT 'account_not_eligible'::text, v_result_expires_at;
    RETURN;
  END IF;

  SELECT r.status, r.access_expires_at
    INTO v_result_status, v_result_expires_at
  FROM public.apply_awakes_membership_event_v030(
    p_email,
    p_event_type,
    p_external_event_id,
    p_occurred_at,
    p_renewal_cycle,
    p_source
  ) r;

  IF p_event_type = 'renewal' AND v_result_status = 'applied' THEN
    UPDATE public.awakes_memberships
    SET payment_state_updated_at = greatest(
          coalesce(payment_state_updated_at, '-infinity'::timestamptz),
          p_occurred_at
        ),
        last_payment_state_event_id = trim(p_external_event_id)
    WHERE email = v_email;
  END IF;

  RETURN QUERY SELECT v_result_status, v_result_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_awakes_membership_event(
  text, text, text, timestamptz, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_awakes_membership_event(
  text, text, text, timestamptz, integer, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_awakes_payment_state_event(
  p_email text,
  p_state text,
  p_external_event_id text,
  p_occurred_at timestamptz,
  p_source text
)
RETURNS TABLE (
  status text,
  membership_status text,
  profiles_changed integer,
  pending_changed integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_source text := trim(p_source);
  v_external_event_id text := trim(p_external_event_id);
  v_membership public.awakes_memberships%ROWTYPE;
  v_resulting_status text;
  v_event_id uuid;
  v_profiles_changed integer := 0;
  v_pending_changed integer := 0;
BEGIN
  IF v_email = '' OR position('@' IN v_email) <= 1 THEN
    RAISE EXCEPTION 'A valid email is required';
  END IF;
  IF p_state NOT IN ('payment_failed', 'payment_restored') THEN
    RAISE EXCEPTION 'Unsupported AWAKES payment state';
  END IF;
  IF coalesce(length(v_external_event_id), 0) = 0
     OR length(v_external_event_id) > 200 THEN
    RAISE EXCEPTION 'A valid external event ID is required';
  END IF;
  IF coalesce(length(v_source), 0) = 0 OR length(v_source) > 100 THEN
    RAISE EXCEPTION 'A valid event source is required';
  END IF;
  IF p_occurred_at IS NULL OR p_occurred_at > now() + interval '1 day' THEN
    RAISE EXCEPTION 'A valid event time is required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.awakes_payment_state_events
    WHERE source = v_source AND external_event_id = v_external_event_id
  ) THEN
    SELECT resulting_membership_status INTO v_resulting_status
    FROM public.awakes_payment_state_events
    WHERE source = v_source AND external_event_id = v_external_event_id
    LIMIT 1;
    RETURN QUERY SELECT 'duplicate'::text, v_resulting_status, 0, 0;
    RETURN;
  END IF;

  SELECT * INTO v_membership
  FROM public.awakes_memberships
  WHERE email = v_email
  FOR UPDATE;

  IF FOUND
     AND v_membership.payment_state_updated_at IS NOT NULL
     AND (
       p_occurred_at < v_membership.payment_state_updated_at
       OR (
         p_occurred_at = v_membership.payment_state_updated_at
         AND p_state = 'payment_restored'
         AND v_membership.status = 'payment_failed'
       )
     ) THEN
    INSERT INTO public.awakes_payment_state_events (
      email, state, source, external_event_id, occurred_at,
      resulting_membership_status
    ) VALUES (
      v_email, p_state, v_source, v_external_event_id, p_occurred_at,
      v_membership.status
    )
    ON CONFLICT DO NOTHING;
    RETURN QUERY SELECT 'stale'::text, v_membership.status, 0, 0;
    RETURN;
  END IF;

  IF p_state = 'payment_restored' THEN
    IF v_membership.email IS NULL THEN
      v_resulting_status := 'missing';
    ELSIF v_membership.status = 'cancelled' THEN
      v_resulting_status := 'cancelled';
    ELSIF v_membership.expires_at <= now() OR v_membership.status = 'expired' THEN
      v_resulting_status := 'expired';
    ELSE
      v_resulting_status := 'active';
    END IF;
  ELSE
    v_resulting_status := CASE
      WHEN v_membership.email IS NULL THEN 'missing'
      WHEN v_membership.status = 'active' THEN 'payment_failed'
      ELSE v_membership.status
    END;
  END IF;

  INSERT INTO public.awakes_payment_state_events (
    email, state, source, external_event_id, occurred_at,
    resulting_membership_status
  ) VALUES (
    v_email, p_state, v_source, v_external_event_id, p_occurred_at,
    v_resulting_status
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT resulting_membership_status INTO v_resulting_status
    FROM public.awakes_payment_state_events
    WHERE source = v_source AND external_event_id = v_external_event_id
    LIMIT 1;
    RETURN QUERY SELECT 'duplicate'::text, v_resulting_status, 0, 0;
    RETURN;
  END IF;

  IF p_state = 'payment_failed' THEN
    IF v_membership.email IS NOT NULL THEN
      UPDATE public.awakes_memberships
      SET status = v_resulting_status,
          payment_state_updated_at = p_occurred_at,
          last_payment_state_event_id = v_external_event_id,
          source = v_source,
          updated_at = now()
      WHERE email = v_email;
    END IF;

    DELETE FROM public.pending_activations WHERE email = v_email;
    GET DIAGNOSTICS v_pending_changed = ROW_COUNT;

    UPDATE public.profiles
    SET subscription_status = CASE
          WHEN subscription_status IN ('cancelled', 'expired')
            THEN subscription_status
          ELSE 'payment_failed'
        END,
        is_active = false,
        awakes_access_updated_at = now(),
        awakes_access_source = v_source,
        updated_at = now()
    WHERE role <> 'admin'
      AND coalesce(is_internal_coaching_monitor, false) = false
      AND (
        lower(myasp_customer_email) = v_email
        OR (
          myasp_customer_email IS NULL
          AND lower(email) = v_email
          AND awakes_access_started_at IS NOT NULL
        )
      );
    GET DIAGNOSTICS v_profiles_changed = ROW_COUNT;

    RETURN QUERY SELECT 'applied'::text, v_resulting_status,
      v_profiles_changed, v_pending_changed;
    RETURN;
  END IF;

  IF v_resulting_status = 'missing' THEN
    RETURN QUERY SELECT 'membership_missing'::text, v_resulting_status, 0, 0;
    RETURN;
  END IF;
  IF v_resulting_status = 'cancelled' THEN
    RETURN QUERY SELECT 'account_not_eligible'::text, v_resulting_status, 0, 0;
    RETURN;
  END IF;
  IF v_resulting_status = 'expired' THEN
    RETURN QUERY SELECT 'term_expired'::text, v_resulting_status, 0, 0;
    RETURN;
  END IF;

  UPDATE public.awakes_memberships
  SET status = 'active',
      payment_state_updated_at = p_occurred_at,
      last_payment_state_event_id = v_external_event_id,
      source = v_source,
      verified_at = now(),
      updated_at = now()
  WHERE email = v_email;

  INSERT INTO public.pending_activations (
    email, source, access_started_at, access_expires_at, external_event_id
  ) VALUES (
    v_email, v_source, v_membership.started_at, v_membership.expires_at,
    v_external_event_id
  )
  ON CONFLICT (email) DO UPDATE SET
    source = excluded.source,
    access_started_at = excluded.access_started_at,
    access_expires_at = excluded.access_expires_at,
    external_event_id = excluded.external_event_id;
  GET DIAGNOSTICS v_pending_changed = ROW_COUNT;

  UPDATE public.profiles
  SET subscription_status = 'active',
      is_active = true,
      awakes_access_started_at = v_membership.started_at,
      awakes_access_expires_at = v_membership.expires_at,
      awakes_access_updated_at = now(),
      awakes_access_source = v_source,
      awakes_expired_at = NULL,
      updated_at = now()
  WHERE role <> 'admin'
    AND coalesce(is_internal_coaching_monitor, false) = false
    AND subscription_status = 'payment_failed'
    AND (
      lower(myasp_customer_email) = v_email
      OR (
        myasp_customer_email IS NULL
        AND lower(email) = v_email
        AND awakes_access_started_at IS NOT NULL
      )
    );
  GET DIAGNOSTICS v_profiles_changed = ROW_COUNT;

  RETURN QUERY SELECT 'applied'::text, 'active'::text,
    v_profiles_changed, v_pending_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_awakes_payment_state_event(
  text, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_awakes_payment_state_event(
  text, text, text, timestamptz, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
