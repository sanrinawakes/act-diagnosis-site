-- Prevent automated bursts from repeatedly invoking the coaching provider.
-- Only a LINE user identifier and a short-lived counter are retained; message
-- content is never stored here.
CREATE TABLE IF NOT EXISTS public.line_message_rate_windows (
  line_user_id text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.line_message_rate_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.line_message_rate_windows FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_message_rate_windows TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_line_message_rate(
  p_line_user_id text,
  p_limit integer DEFAULT 12,
  p_window_seconds integer DEFAULT 60
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_started_at timestamptz;
  v_message_count integer;
  v_now timestamptz := now();
  v_retry_after_seconds integer;
BEGIN
  IF coalesce(length(trim(p_line_user_id)), 0) = 0
     OR p_limit < 1
     OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'Invalid LINE message rate reservation';
  END IF;

  INSERT INTO public.line_message_rate_windows (line_user_id)
  VALUES (p_line_user_id)
  ON CONFLICT (line_user_id) DO NOTHING;

  SELECT window_started_at, message_count
  INTO v_window_started_at, v_message_count
  FROM public.line_message_rate_windows
  WHERE line_user_id = p_line_user_id
  FOR UPDATE;

  IF v_window_started_at <= v_now - make_interval(secs => p_window_seconds) THEN
    UPDATE public.line_message_rate_windows
    SET window_started_at = v_now,
        message_count = 1,
        updated_at = v_now
    WHERE line_user_id = p_line_user_id;
    RETURN QUERY SELECT true, 0;
    RETURN;
  END IF;

  IF v_message_count >= p_limit THEN
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch FROM (v_window_started_at + make_interval(secs => p_window_seconds) - v_now)))::integer
    );
    RETURN QUERY SELECT false, v_retry_after_seconds;
    RETURN;
  END IF;

  UPDATE public.line_message_rate_windows
  SET message_count = v_message_count + 1,
      updated_at = v_now
  WHERE line_user_id = p_line_user_id;
  RETURN QUERY SELECT true, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_line_message_rate(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_line_message_rate(text, integer, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
