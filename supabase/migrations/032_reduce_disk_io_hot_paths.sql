-- Reduce reads on the three chat-message access paths that dominate the
-- production query report, and make stale monitor cleanup touch only the
-- small set of running rows.
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_role_created
  ON public.chat_messages(session_id, role, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_assistant_created_id
  ON public.chat_messages(created_at DESC, id DESC)
  WHERE role = 'assistant';

CREATE INDEX IF NOT EXISTS idx_coaching_monitor_runs_running_checked_at
  ON public.coaching_monitor_runs(checked_at)
  WHERE status = 'running';
