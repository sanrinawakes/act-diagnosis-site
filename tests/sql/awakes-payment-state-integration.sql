BEGIN;

DO $$
DECLARE
  v_user_id uuid := gen_random_uuid();
  v_status text;
  v_membership_status text;
  v_profiles_changed integer;
  v_pending_changed integer;
  v_failure_time timestamptz := now() - interval '1 minute';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_user_id, 'payment-state-test@example.test');
  UPDATE public.profiles
  SET myasp_customer_email = 'payment-state-test@example.test',
      subscription_status = 'none',
      is_active = false
  WHERE id = v_user_id;

  SELECT status INTO v_status
  FROM public.apply_awakes_membership_event(
    'payment-state-test@example.test', 'initial', 'initial-1',
    now() - interval '6 months', 0, 'integration-initial'
  );
  IF v_status <> 'applied' THEN
    RAISE EXCEPTION 'initial membership was not applied: %', v_status;
  END IF;

  SELECT status, membership_status, profiles_changed, pending_changed
    INTO v_status, v_membership_status, v_profiles_changed, v_pending_changed
  FROM public.apply_awakes_payment_state_event(
    'payment-state-test@example.test', 'payment_failed', 'failed-1',
    v_failure_time, 'integration-billing'
  );
  IF v_status <> 'applied' OR v_membership_status <> 'payment_failed'
     OR v_profiles_changed <> 1 OR v_pending_changed <> 1 THEN
    RAISE EXCEPTION 'payment failure was not applied atomically: %, %, %, %',
      v_status, v_membership_status, v_profiles_changed, v_pending_changed;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_user_id AND subscription_status = 'payment_failed'
      AND is_active = false
  ) OR EXISTS (
    SELECT 1 FROM public.pending_activations
    WHERE email = 'payment-state-test@example.test'
  ) THEN
    RAISE EXCEPTION 'payment failure left an active or claimable entitlement';
  END IF;

  SELECT status INTO v_status
  FROM public.apply_awakes_payment_state_event(
    'payment-state-test@example.test', 'payment_failed', 'failed-1',
    v_failure_time, 'integration-billing'
  );
  IF v_status <> 'duplicate' THEN
    RAISE EXCEPTION 'duplicate payment failure was not deduplicated: %', v_status;
  END IF;

  SELECT status INTO v_status
  FROM public.apply_awakes_membership_event(
    'payment-state-test@example.test', 'initial', 'initial-retry',
    now(), 0, 'integration-initial'
  );
  IF v_status <> 'account_not_eligible' OR EXISTS (
    SELECT 1 FROM public.pending_activations
    WHERE email = 'payment-state-test@example.test'
  ) THEN
    RAISE EXCEPTION 'initial retry reopened a payment-failed membership';
  END IF;

  SELECT status INTO v_status
  FROM public.apply_awakes_payment_state_event(
    'payment-state-test@example.test', 'payment_restored', 'restore-stale',
    v_failure_time - interval '1 minute', 'integration-billing'
  );
  IF v_status <> 'stale' THEN
    RAISE EXCEPTION 'out-of-order restore was not ignored: %', v_status;
  END IF;

  SELECT status INTO v_status
  FROM public.apply_awakes_payment_state_event(
    'payment-state-test@example.test', 'payment_restored', 'restore-equal-time',
    v_failure_time, 'integration-billing'
  );
  IF v_status <> 'stale' THEN
    RAISE EXCEPTION 'equal-time restore did not fail closed: %', v_status;
  END IF;

  SELECT status, membership_status, profiles_changed
    INTO v_status, v_membership_status, v_profiles_changed
  FROM public.apply_awakes_payment_state_event(
    'payment-state-test@example.test', 'payment_restored', 'restore-1',
    now(), 'integration-billing'
  );
  IF v_status <> 'applied' OR v_membership_status <> 'active'
     OR v_profiles_changed <> 1 THEN
    RAISE EXCEPTION 'successful retry did not restore current term: %, %, %',
      v_status, v_membership_status, v_profiles_changed;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_user_id AND subscription_status = 'active'
      AND is_active = true
  ) OR NOT EXISTS (
    SELECT 1 FROM public.pending_activations
    WHERE email = 'payment-state-test@example.test'
  ) THEN
    RAISE EXCEPTION 'successful retry did not restore linked and pending access';
  END IF;

  UPDATE public.awakes_memberships
  SET status = 'expired', expires_at = now() - interval '1 minute'
  WHERE email = 'payment-state-test@example.test';
  UPDATE public.profiles
  SET subscription_status = 'payment_failed', is_active = false
  WHERE id = v_user_id;

  SELECT status INTO v_status
  FROM public.apply_awakes_payment_state_event(
    'payment-state-test@example.test', 'payment_restored', 'restore-expired',
    now() + interval '1 second', 'integration-billing'
  );
  IF v_status <> 'term_expired' OR EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_user_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'payment restored access after the one-year term expired';
  END IF;
END;
$$;

ROLLBACK;
