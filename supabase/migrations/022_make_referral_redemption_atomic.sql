-- Redeeming a referral code changes credits and a one-time marker together.
-- Keep that operation in one row lock so concurrent requests cannot race.
CREATE OR REPLACE FUNCTION public.redeem_referral_code(
  p_user_id uuid,
  p_referral_code text,
  p_credits integer
)
RETURNS TABLE(status text, paid_test_credits integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used_code text;
  v_credits integer;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 OR p_credits > 100 THEN
    RAISE EXCEPTION 'invalid credit amount';
  END IF;

  SELECT referral_code_used, COALESCE(paid_test_credits, 0)
  INTO v_used_code, v_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'profile_missing'::text, NULL::integer;
    RETURN;
  END IF;

  IF v_used_code IS NOT NULL THEN
    RETURN QUERY SELECT 'already_used'::text, v_credits;
    RETURN;
  END IF;

  UPDATE public.profiles
  SET
    referral_code_used = p_referral_code,
    paid_test_credits = v_credits + p_credits,
    updated_at = NOW()
  WHERE id = p_user_id;

  RETURN QUERY SELECT 'applied'::text, v_credits + p_credits;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_referral_code(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_referral_code(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.redeem_referral_code(uuid, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_referral_code(uuid, text, integer) TO service_role;
