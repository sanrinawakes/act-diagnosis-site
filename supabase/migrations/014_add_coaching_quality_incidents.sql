-- Durable queue for semantic failures that still returned HTTP 200.
-- Customer message bodies are intentionally kept out of this table.
CREATE TABLE IF NOT EXISTS public.coaching_quality_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_message_id uuid NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  issue text NOT NULL CHECK (
    issue IN (
      'internal_context_exposure',
      'repeated_response_after_dissatisfaction',
      'repeated_response_three_times',
      'post_delivery_quality_failure',
      'quality_safety_hold',
      'unresolved_quality_issue'
    )
  ),
  source text NOT NULL CHECK (source IN ('response_gate', 'scheduled_audit')),
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'in_progress', 'resolved', 'ignored')
  ),
  message_created_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  deployment_commit text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_run_id text,
  claimed_at timestamptz,
  resolution_kind text CHECK (
    resolution_kind IS NULL OR
    resolution_kind IN ('technical_fix', 'false_positive', 'no_code_change')
  ),
  resolution_note text,
  resolution_evidence jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coaching_quality_incidents_message_issue_key
    UNIQUE (assistant_message_id, issue),
  CONSTRAINT coaching_quality_incidents_claim_matches_status CHECK (
    (status = 'in_progress' AND claimed_run_id IS NOT NULL AND claimed_at IS NOT NULL) OR
    (status <> 'in_progress')
  ),
  CONSTRAINT coaching_quality_incidents_resolution_matches_status CHECK (
    (status IN ('resolved', 'ignored') AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL) OR
    (status NOT IN ('resolved', 'ignored'))
  )
);

CREATE INDEX IF NOT EXISTS idx_coaching_quality_incidents_queue
  ON public.coaching_quality_incidents(status, detected_at ASC);
CREATE INDEX IF NOT EXISTS idx_coaching_quality_incidents_session
  ON public.coaching_quality_incidents(session_id, message_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_quality_incidents_user
  ON public.coaching_quality_incidents(user_id, message_created_at DESC);

ALTER TABLE public.coaching_quality_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coaching_quality_incidents FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.coaching_quality_incidents TO service_role;
