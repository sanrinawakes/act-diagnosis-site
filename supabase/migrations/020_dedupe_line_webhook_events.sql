-- Never retain consultation text in this idempotency table. It only records
-- provider event identifiers so a webhook retry cannot create a second AI call.
CREATE TABLE IF NOT EXISTS public.line_webhook_events (
  event_key text PRIMARY KEY,
  event_type text NOT NULL,
  message_id text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'complete', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_webhook_events_recovery
  ON public.line_webhook_events(status, started_at);

ALTER TABLE public.line_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.line_webhook_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.line_webhook_events TO service_role;

CREATE OR REPLACE FUNCTION public.claim_line_webhook_event(
  p_event_key text,
  p_event_type text,
  p_message_id text
)
RETURNS TABLE (claimed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  INSERT INTO public.line_webhook_events (
    event_key,
    event_type,
    message_id,
    status,
    attempts,
    started_at,
    updated_at
  )
  VALUES (
    p_event_key,
    p_event_type,
    p_message_id,
    'processing',
    1,
    now(),
    now()
  )
  ON CONFLICT (event_key) DO UPDATE
  SET
    status = 'processing',
    attempts = public.line_webhook_events.attempts + 1,
    started_at = now(),
    failed_at = null,
    updated_at = now()
  WHERE public.line_webhook_events.status = 'failed'
     OR (
       public.line_webhook_events.status = 'processing'
       AND public.line_webhook_events.started_at < now() - interval '5 minutes'
     )
  RETURNING true INTO v_claimed;

  RETURN QUERY SELECT v_claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_line_webhook_event(
  p_event_key text,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('complete', 'failed') THEN
    RAISE EXCEPTION 'Invalid LINE webhook completion status';
  END IF;

  UPDATE public.line_webhook_events
  SET
    status = p_status,
    completed_at = CASE WHEN p_status = 'complete' THEN now() ELSE completed_at END,
    failed_at = CASE WHEN p_status = 'failed' THEN now() ELSE failed_at END,
    updated_at = now()
  WHERE event_key = p_event_key;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_line_webhook_event(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_line_webhook_event(text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.complete_line_webhook_event(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_line_webhook_event(text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
