-- Free coaching must reserve quota before an external model call. A simple
-- read-then-update counter lets parallel browser requests exceed the limit.
CREATE TABLE IF NOT EXISTS public.free_coaching_daily_usage (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  usage_day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_free_coaching_daily_usage_user_day
  ON public.free_coaching_daily_usage(user_id, usage_day);

ALTER TABLE public.free_coaching_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.free_coaching_daily_usage FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.free_coaching_daily_usage TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_free_coaching_daily_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_usage_day date,
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
  v_existing_day date;
BEGIN
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'Free coaching limit must be positive';
  END IF;

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  SELECT user_id, usage_day
  INTO v_existing_user_id, v_existing_day
  FROM public.free_coaching_daily_usage
  WHERE request_id = p_request_id;

  SELECT count(*)::integer
  INTO v_count
  FROM public.free_coaching_daily_usage
  WHERE user_id = p_user_id
    AND usage_day = p_usage_day;

  IF v_existing_user_id IS NOT NULL THEN
    IF v_existing_user_id <> p_user_id OR v_existing_day <> p_usage_day THEN
      RAISE EXCEPTION 'Free coaching request identifier conflict';
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

  INSERT INTO public.free_coaching_daily_usage (request_id, user_id, usage_day)
  VALUES (p_request_id, p_user_id, p_usage_day);

  v_count := v_count + 1;
  RETURN QUERY SELECT
    true,
    v_count,
    greatest(p_limit - v_count, 0),
    true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_free_coaching_daily_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_usage_day date,
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
  v_deleted uuid;
  v_count integer;
BEGIN
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'Free coaching limit must be positive';
  END IF;

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  DELETE FROM public.free_coaching_daily_usage
  WHERE request_id = p_request_id
    AND user_id = p_user_id
    AND usage_day = p_usage_day
  RETURNING request_id INTO v_deleted;

  SELECT count(*)::integer
  INTO v_count
  FROM public.free_coaching_daily_usage
  WHERE user_id = p_user_id
    AND usage_day = p_usage_day;

  RETURN QUERY SELECT
    v_deleted IS NOT NULL,
    v_count,
    greatest(p_limit - v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_free_coaching_daily_usage(uuid, uuid, date, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_free_coaching_daily_usage(uuid, uuid, date, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.release_free_coaching_daily_usage(uuid, uuid, date, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_free_coaching_daily_usage(uuid, uuid, date, integer)
  TO service_role;
