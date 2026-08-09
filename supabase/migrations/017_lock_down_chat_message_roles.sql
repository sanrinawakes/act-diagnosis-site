-- Members may save only their own input. Assistant responses and system memory
-- are created by server routes using the service role, never by a browser.
DROP POLICY IF EXISTS "Users can create messages in their chat sessions"
  ON public.chat_messages;
DROP POLICY IF EXISTS "Users can create their own chat inputs"
  ON public.chat_messages;

CREATE POLICY "Users can create their own chat inputs"
  ON public.chat_messages
  FOR INSERT
  WITH CHECK (
    role = 'user'
    AND EXISTS (
      SELECT 1
      FROM public.chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
        AND chat_sessions.user_id = auth.uid()
    )
  );
