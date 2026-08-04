-- Paid coaching uses a Japanese calendar-month allowance. The legacy daily
-- columns remain for free coaching and rollback compatibility.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS chat_count_month integer NOT NULL DEFAULT 0;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS chat_month_start date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'profiles_chat_count_month_nonnegative'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_chat_count_month_nonnegative
      CHECK (chat_count_month >= 0);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.coaching_monthly_usage (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coaching_monthly_usage_period_start_check
    CHECK (period_start = date_trunc('month', period_start::timestamp)::date)
);

CREATE INDEX IF NOT EXISTS idx_coaching_monthly_usage_user_period
  ON public.coaching_monthly_usage(user_id, period_start);

ALTER TABLE public.coaching_monthly_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coaching_monthly_usage FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.coaching_monthly_usage TO service_role;

-- Preserve the current month's already-recorded paid usage when this change is
-- introduced. Scope-blocked requests did not consume the previous allowance.
INSERT INTO public.coaching_monthly_usage (
  request_id,
  user_id,
  period_start,
  created_at
)
SELECT
  events.request_id,
  events.user_id,
  date_trunc('month', timezone('Asia/Tokyo', events.created_at))::date,
  events.created_at
FROM public.coaching_usage_events AS events
WHERE events.decision = 'allowed'
ON CONFLICT (request_id) DO NOTHING;

WITH current_period AS (
  SELECT date_trunc('month', timezone('Asia/Tokyo', now()))::date AS value
)
UPDATE public.profiles AS profiles
SET
  chat_month_start = current_period.value,
  chat_count_month = coalesce((
    SELECT count(*)::integer
    FROM public.coaching_monthly_usage AS usage
    WHERE usage.user_id = profiles.id
      AND usage.period_start = current_period.value
  ), 0)
FROM current_period;

CREATE OR REPLACE VIEW public.coaching_usage_by_user
WITH (security_invoker = true)
AS
SELECT
  stats.user_id,
  profiles.email,
  profiles.display_name,
  stats.total_requests,
  stats.allowed_requests,
  stats.blocked_requests,
  stats.long_message_requests,
  stats.attachment_requests,
  stats.last_request_at,
  stats.last_blocked_at,
  profiles.chat_count_month,
  profiles.chat_month_start
FROM public.coaching_usage_user_stats AS stats
JOIN public.profiles AS profiles ON profiles.id = stats.user_id;

REVOKE ALL ON TABLE public.coaching_usage_by_user FROM anon, authenticated;
GRANT SELECT ON TABLE public.coaching_usage_by_user TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_coaching_monthly_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_period_start date,
  p_limit integer
)
RETURNS TABLE (
  allowed boolean,
  usage_count integer,
  remaining integer,
  reserved_now boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_existing_user_id uuid;
  v_existing_period date;
BEGIN
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'Monthly coaching limit must be positive';
  END IF;
  IF p_period_start <> date_trunc('month', p_period_start::timestamp)::date THEN
    RAISE EXCEPTION 'Invalid monthly coaching period';
  END IF;

  SELECT profiles.chat_count_month
  INTO v_count
  FROM public.profiles AS profiles
  WHERE profiles.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  UPDATE public.profiles AS profiles
  SET
    chat_month_start = p_period_start,
    chat_count_month = 0
  WHERE profiles.id = p_user_id
    AND profiles.chat_month_start IS DISTINCT FROM p_period_start;

  SELECT usage.user_id, usage.period_start
  INTO v_existing_user_id, v_existing_period
  FROM public.coaching_monthly_usage AS usage
  WHERE usage.request_id = p_request_id;

  SELECT profiles.chat_count_month
  INTO v_count
  FROM public.profiles AS profiles
  WHERE profiles.id = p_user_id;

  IF v_existing_user_id IS NOT NULL THEN
    IF v_existing_user_id <> p_user_id OR v_existing_period <> p_period_start THEN
      RAISE EXCEPTION 'Monthly coaching request identifier conflict';
    END IF;
    RETURN QUERY SELECT
      true,
      v_count,
      greatest(p_limit - v_count, 0),
      false;
    RETURN;
  END IF;

  IF v_count >= p_limit THEN
    RETURN QUERY SELECT false, v_count, 0, false;
    RETURN;
  END IF;

  INSERT INTO public.coaching_monthly_usage (
    request_id,
    user_id,
    period_start
  )
  VALUES (p_request_id, p_user_id, p_period_start);

  v_count := v_count + 1;
  UPDATE public.profiles AS profiles
  SET chat_count_month = v_count
  WHERE profiles.id = p_user_id;

  RETURN QUERY SELECT
    true,
    v_count,
    greatest(p_limit - v_count, 0),
    true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_coaching_monthly_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_period_start date,
  p_limit integer
)
RETURNS TABLE (
  released boolean,
  usage_count integer,
  remaining integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_deleted uuid;
BEGIN
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'Monthly coaching limit must be positive';
  END IF;
  IF p_period_start <> date_trunc('month', p_period_start::timestamp)::date THEN
    RAISE EXCEPTION 'Invalid monthly coaching period';
  END IF;

  SELECT profiles.chat_count_month
  INTO v_count
  FROM public.profiles AS profiles
  WHERE profiles.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  DELETE FROM public.coaching_monthly_usage AS usage
  WHERE usage.request_id = p_request_id
    AND usage.user_id = p_user_id
    AND usage.period_start = p_period_start
  RETURNING usage.request_id INTO v_deleted;

  IF v_deleted IS NOT NULL THEN
    UPDATE public.profiles AS profiles
    SET chat_count_month = greatest(profiles.chat_count_month - 1, 0)
    WHERE profiles.id = p_user_id
      AND profiles.chat_month_start = p_period_start
    RETURNING profiles.chat_count_month INTO v_count;
  END IF;

  RETURN QUERY SELECT
    v_deleted IS NOT NULL,
    v_count,
    greatest(p_limit - v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_coaching_monthly_usage(uuid, uuid, date, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_coaching_monthly_usage(uuid, uuid, date, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.release_coaching_monthly_usage(uuid, uuid, date, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_coaching_monthly_usage(uuid, uuid, date, integer)
  TO service_role;
