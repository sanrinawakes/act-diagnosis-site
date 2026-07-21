-- Keep an auditable result for every paid coaching monitor invocation.
-- No user message text or other private coaching content is stored here.
CREATE TABLE IF NOT EXISTS public.coaching_monitor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('running', 'success', 'failure')),
  monitor_path text NOT NULL,
  base_url text NOT NULL,
  deployment_commit text,
  deployment_id text,
  deployment_url text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  elapsed_ms integer NOT NULL CHECK (elapsed_ms >= 0),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  input_messages integer CHECK (input_messages >= 0),
  stored_messages_before_reply integer CHECK (stored_messages_before_reply >= 0),
  stored_messages_after_reply integer CHECK (stored_messages_after_reply >= 0),
  payload_bytes integer CHECK (payload_bytes >= 0),
  first_chunk_ms integer CHECK (first_chunk_ms >= 0),
  chat_total_ms integer CHECK (chat_total_ms >= 0),
  journey_total_ms integer CHECK (journey_total_ms >= 0),
  output_chars integer CHECK (output_chars >= 0),
  returned_fallback boolean,
  provider text,
  fallback_from text,
  completion_status text,
  finalization_status text,
  has_done boolean,
  remaining integer CHECK (remaining >= 0),
  cookie_auth_used boolean,
  stage_timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  alert_accepted boolean,
  alert_status integer CHECK (alert_status BETWEEN 100 AND 599),
  alert_resend_id text,
  alert_reason text,
  CONSTRAINT coaching_monitor_runs_error_matches_status CHECK (
    (status IN ('running', 'success') AND error IS NULL) OR
    (status = 'failure' AND error IS NOT NULL)
  )
);

-- Keep the migration safe when an earlier draft of this table was applied.
ALTER TABLE public.coaching_monitor_runs
  ADD COLUMN IF NOT EXISTS has_done boolean,
  ADD COLUMN IF NOT EXISTS remaining integer CHECK (remaining >= 0),
  ADD COLUMN IF NOT EXISTS cookie_auth_used boolean;

ALTER TABLE public.coaching_monitor_runs
  DROP CONSTRAINT IF EXISTS coaching_monitor_runs_status_check;
ALTER TABLE public.coaching_monitor_runs
  ADD CONSTRAINT coaching_monitor_runs_status_check
  CHECK (status IN ('running', 'success', 'failure'));
ALTER TABLE public.coaching_monitor_runs
  DROP CONSTRAINT IF EXISTS coaching_monitor_runs_error_matches_status;
ALTER TABLE public.coaching_monitor_runs
  ADD CONSTRAINT coaching_monitor_runs_error_matches_status CHECK (
    (status IN ('running', 'success') AND error IS NULL) OR
    (status = 'failure' AND error IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_coaching_monitor_runs_checked_at
  ON public.coaching_monitor_runs(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_monitor_runs_failure_checked_at
  ON public.coaching_monitor_runs(checked_at DESC)
  WHERE status = 'failure';

ALTER TABLE public.coaching_monitor_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coaching_monitor_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.coaching_monitor_runs TO service_role;
