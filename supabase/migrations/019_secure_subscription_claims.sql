-- A MyASP email address alone must never activate a different ACTI account.
-- Codes are HMAC hashes only; plaintext codes are delivered once by email and
-- never stored in the database.
CREATE TABLE IF NOT EXISTS public.subscription_claim_challenges (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  awakes_email text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, awakes_email)
);

CREATE INDEX IF NOT EXISTS idx_subscription_claim_challenges_expiry
  ON public.subscription_claim_challenges(expires_at);

ALTER TABLE public.subscription_claim_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_claim_challenges FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_claim_challenges TO service_role;

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
  v_subscription_status text;
  v_pending_activated boolean;
BEGIN
  IF p_max_attempts < 1 THEN
    RAISE EXCEPTION 'Subscription claim attempt limit must be positive';
  END IF;

  SELECT *
  INTO v_challenge
  FROM public.subscription_claim_challenges
  WHERE user_id = p_user_id
    AND awakes_email = lower(trim(p_awakes_email))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'challenge_missing';
    RETURN;
  END IF;

  IF v_challenge.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_consumed';
    RETURN;
  END IF;

  IF v_challenge.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired';
    RETURN;
  END IF;

  IF v_challenge.attempts >= p_max_attempts THEN
    RETURN QUERY SELECT 'locked';
    RETURN;
  END IF;

  IF v_challenge.code_hash <> p_code_hash THEN
    UPDATE public.subscription_claim_challenges
    SET attempts = attempts + 1, updated_at = now()
    WHERE user_id = p_user_id
      AND awakes_email = lower(trim(p_awakes_email));
    RETURN QUERY SELECT 'invalid_code';
    RETURN;
  END IF;

  SELECT subscription_status
  INTO v_subscription_status
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'profile_missing';
    RETURN;
  END IF;

  IF v_subscription_status = 'active' THEN
    UPDATE public.subscription_claim_challenges
    SET consumed_at = now(), updated_at = now()
    WHERE user_id = p_user_id
      AND awakes_email = lower(trim(p_awakes_email));
    RETURN QUERY SELECT 'already_active';
    RETURN;
  END IF;

  IF v_subscription_status IN ('cancelled', 'payment_failed') THEN
    RETURN QUERY SELECT 'account_not_eligible';
    RETURN;
  END IF;

  SELECT activated
  INTO v_pending_activated
  FROM public.pending_activations
  WHERE email = lower(trim(p_awakes_email))
  FOR UPDATE;

  IF NOT FOUND OR v_pending_activated THEN
    RETURN QUERY SELECT 'payment_not_eligible';
    RETURN;
  END IF;

  UPDATE public.profiles
  SET
    subscription_status = 'active',
    is_active = true,
    subscribed_at = now(),
    myasp_customer_email = lower(trim(p_awakes_email)),
    updated_at = now()
  WHERE id = p_user_id;

  UPDATE public.pending_activations
  SET activated = true, activated_at = now()
  WHERE email = lower(trim(p_awakes_email))
    AND activated = false;

  UPDATE public.subscription_claim_challenges
  SET consumed_at = now(), updated_at = now()
  WHERE user_id = p_user_id
    AND awakes_email = lower(trim(p_awakes_email));

  RETURN QUERY SELECT 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.consume_verified_subscription_claim(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_verified_subscription_claim(uuid, text, text, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
