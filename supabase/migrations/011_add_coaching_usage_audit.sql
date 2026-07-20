-- Record AI coaching requests without duplicating the user's private message text.
CREATE TABLE IF NOT EXISTS public.coaching_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.chat_sessions(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('allowed', 'blocked')),
  category text NOT NULL CHECK (
    category IN (
      'coaching',
      'conversation_followup',
      'writing_editing',
      'marketing_content',
      'translation',
      'external_research',
      'image_generation',
      'programming',
      'ambiguous'
    )
  ),
  matched_rule text NOT NULL,
  message_chars integer NOT NULL CHECK (message_chars >= 0),
  total_request_chars integer NOT NULL CHECK (total_request_chars >= 0),
  line_count integer NOT NULL CHECK (line_count >= 0),
  is_long_message boolean NOT NULL DEFAULT false,
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  provider_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_usage_events_user_created
  ON public.coaching_usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_usage_events_created
  ON public.coaching_usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_usage_events_decision_created
  ON public.coaching_usage_events(decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_usage_events_long_created
  ON public.coaching_usage_events(is_long_message, created_at DESC)
  WHERE is_long_message = true;

ALTER TABLE public.coaching_usage_events ENABLE ROW LEVEL SECURITY;

-- Requests are written and read only through authenticated server routes.
REVOKE ALL ON TABLE public.coaching_usage_events FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.coaching_usage_events TO service_role;

CREATE TABLE IF NOT EXISTS public.coaching_usage_user_stats (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_requests bigint NOT NULL DEFAULT 0 CHECK (total_requests >= 0),
  allowed_requests bigint NOT NULL DEFAULT 0 CHECK (allowed_requests >= 0),
  blocked_requests bigint NOT NULL DEFAULT 0 CHECK (blocked_requests >= 0),
  long_message_requests bigint NOT NULL DEFAULT 0 CHECK (long_message_requests >= 0),
  attachment_requests bigint NOT NULL DEFAULT 0 CHECK (attachment_requests >= 0),
  last_request_at timestamptz,
  last_blocked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaching_usage_user_stats_last_request
  ON public.coaching_usage_user_stats(last_request_at DESC);

ALTER TABLE public.coaching_usage_user_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coaching_usage_user_stats FROM anon, authenticated;
GRANT SELECT ON TABLE public.coaching_usage_user_stats TO service_role;

-- Rebuild exact totals when this migration is re-run or applied after events exist.
INSERT INTO public.coaching_usage_user_stats (
  user_id,
  total_requests,
  allowed_requests,
  blocked_requests,
  long_message_requests,
  attachment_requests,
  last_request_at,
  last_blocked_at,
  updated_at
)
SELECT
  user_id,
  count(*)::bigint,
  count(*) FILTER (WHERE decision = 'allowed')::bigint,
  count(*) FILTER (WHERE decision = 'blocked')::bigint,
  count(*) FILTER (WHERE is_long_message)::bigint,
  count(*) FILTER (WHERE attachment_count > 0)::bigint,
  max(created_at),
  max(created_at) FILTER (WHERE decision = 'blocked'),
  now()
FROM public.coaching_usage_events
GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE SET
  total_requests = EXCLUDED.total_requests,
  allowed_requests = EXCLUDED.allowed_requests,
  blocked_requests = EXCLUDED.blocked_requests,
  long_message_requests = EXCLUDED.long_message_requests,
  attachment_requests = EXCLUDED.attachment_requests,
  last_request_at = EXCLUDED.last_request_at,
  last_blocked_at = EXCLUDED.last_blocked_at,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.update_coaching_usage_user_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.coaching_usage_user_stats (
    user_id,
    total_requests,
    allowed_requests,
    blocked_requests,
    long_message_requests,
    attachment_requests,
    last_request_at,
    last_blocked_at,
    updated_at
  )
  VALUES (
    NEW.user_id,
    1,
    CASE WHEN NEW.decision = 'allowed' THEN 1 ELSE 0 END,
    CASE WHEN NEW.decision = 'blocked' THEN 1 ELSE 0 END,
    CASE WHEN NEW.is_long_message THEN 1 ELSE 0 END,
    CASE WHEN NEW.attachment_count > 0 THEN 1 ELSE 0 END,
    NEW.created_at,
    CASE WHEN NEW.decision = 'blocked' THEN NEW.created_at ELSE NULL END,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    total_requests = coaching_usage_user_stats.total_requests + 1,
    allowed_requests = coaching_usage_user_stats.allowed_requests +
      CASE WHEN NEW.decision = 'allowed' THEN 1 ELSE 0 END,
    blocked_requests = coaching_usage_user_stats.blocked_requests +
      CASE WHEN NEW.decision = 'blocked' THEN 1 ELSE 0 END,
    long_message_requests = coaching_usage_user_stats.long_message_requests +
      CASE WHEN NEW.is_long_message THEN 1 ELSE 0 END,
    attachment_requests = coaching_usage_user_stats.attachment_requests +
      CASE WHEN NEW.attachment_count > 0 THEN 1 ELSE 0 END,
    last_request_at = GREATEST(
      coalesce(coaching_usage_user_stats.last_request_at, NEW.created_at),
      NEW.created_at
    ),
    last_blocked_at = CASE
      WHEN NEW.decision = 'blocked' THEN GREATEST(
        coalesce(coaching_usage_user_stats.last_blocked_at, NEW.created_at),
        NEW.created_at
      )
      ELSE coaching_usage_user_stats.last_blocked_at
    END,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_update_coaching_usage_user_stats
  ON public.coaching_usage_events;
CREATE TRIGGER trigger_update_coaching_usage_user_stats
  AFTER INSERT ON public.coaching_usage_events
  FOR EACH ROW EXECUTE FUNCTION public.update_coaching_usage_user_stats();

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
  stats.last_blocked_at
FROM public.coaching_usage_user_stats AS stats
JOIN public.profiles AS profiles ON profiles.id = stats.user_id;

REVOKE ALL ON TABLE public.coaching_usage_by_user FROM anon, authenticated;
GRANT SELECT ON TABLE public.coaching_usage_by_user TO service_role;

CREATE OR REPLACE VIEW public.coaching_usage_overview
WITH (security_invoker = true)
AS
SELECT
  coalesce(sum(total_requests), 0)::bigint AS total_requests,
  coalesce(sum(blocked_requests), 0)::bigint AS blocked_requests,
  coalesce(sum(long_message_requests), 0)::bigint AS long_message_requests,
  count(*)::bigint AS unique_users
FROM public.coaching_usage_user_stats;

REVOKE ALL ON TABLE public.coaching_usage_overview FROM anon, authenticated;
GRANT SELECT ON TABLE public.coaching_usage_overview TO service_role;
