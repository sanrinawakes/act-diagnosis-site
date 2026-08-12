-- Every uniquely identified paid renewal extends access by one year. The
-- caller must not manage a year counter: that would make future renewals fail
-- when a MyASP form keeps posting the same configured value.
DROP INDEX IF EXISTS public.awakes_membership_events_cycle_unique;

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
  v_source text := trim(p_source);
  v_external_event_id text := trim(p_external_event_id);
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
  IF p_event_type <> 'renewal'
     AND (p_renewal_cycle IS NULL OR p_renewal_cycle < 0 OR p_renewal_cycle > 100) THEN
    RAISE EXCEPTION 'Renewal cycle is out of range';
  END IF;

  -- Return the original result for a webhook retry before calculating another
  -- term. This remains correct even when a retry arrives years later.
  SELECT resulting_expires_at INTO v_expires_at
  FROM public.awakes_membership_events
  WHERE source = v_source
    AND external_event_id = v_external_event_id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'duplicate'::text, v_expires_at;
    RETURN;
  END IF;

  SELECT * INTO v_membership
  FROM public.awakes_memberships
  WHERE email = v_email
  FOR UPDATE;
  v_membership_found := FOUND;

  -- Initial/import retries never reopen a cancelled or payment-failed account.
  -- A new uniquely identified paid renewal may reopen it.
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
      IF v_membership.renewal_cycle >= 100 THEN
        RAISE EXCEPTION 'Renewal cycle is out of range';
      END IF;
      v_cycle := v_membership.renewal_cycle + 1;
      -- An on-time renewal extends the current term. A lapsed member who pays
      -- again receives one year from the new payment time, never a past term.
      v_expires_at := greatest(v_membership.expires_at, p_occurred_at)
        + interval '1 year';
    ELSE
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
    v_email, p_event_type, v_cycle, v_source,
    v_external_event_id, p_occurred_at, v_expires_at
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    -- A concurrent retry may have passed the early check before the first
    -- transaction committed. Return the persisted result, without extending.
    SELECT resulting_expires_at INTO v_expires_at
    FROM public.awakes_membership_events
    WHERE source = v_source
      AND external_event_id = v_external_event_id
    LIMIT 1;
    RETURN QUERY SELECT 'duplicate'::text, v_expires_at;
    RETURN;
  END IF;

  INSERT INTO public.awakes_memberships (
    email, started_at, renewal_cycle, expires_at, status, source,
    last_event_id, verified_at, updated_at
  ) VALUES (
    v_email, v_started_at, v_cycle, v_expires_at,
    CASE WHEN v_expires_at > now() THEN 'active' ELSE 'expired' END,
    v_source, v_external_event_id, now(), now()
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
    v_email, v_source, v_started_at, v_expires_at, v_external_event_id
  )
  ON CONFLICT (email) DO UPDATE SET
    source = excluded.source,
    access_started_at = excluded.access_started_at,
    access_expires_at = excluded.access_expires_at,
    external_event_id = excluded.external_event_id;

  UPDATE public.profiles
  SET
    myasp_customer_email = coalesce(myasp_customer_email, v_email),
    awakes_access_started_at = v_started_at,
    awakes_access_expires_at = v_expires_at,
    awakes_access_updated_at = now(),
    awakes_access_source = v_source,
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

NOTIFY pgrst, 'reload schema';
