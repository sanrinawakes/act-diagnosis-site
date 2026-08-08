-- A member may only attach one of their own diagnosis records to a chat
-- session. Do not rely on client-side selection for this ownership boundary.
DROP POLICY IF EXISTS "Users can create their own chat sessions" ON public.chat_sessions;
CREATE POLICY "Users can create their own chat sessions"
  ON public.chat_sessions FOR INSERT
  WITH CHECK (
    auth.uid() = user_id AND (
      diagnosis_result_id IS NULL OR EXISTS (
        SELECT 1
        FROM public.diagnosis_results
        WHERE id = chat_sessions.diagnosis_result_id
          AND user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "Users can update their own chat sessions" ON public.chat_sessions;
CREATE POLICY "Users can update their own chat sessions"
  ON public.chat_sessions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id AND (
      diagnosis_result_id IS NULL OR EXISTS (
        SELECT 1
        FROM public.diagnosis_results
        WHERE id = chat_sessions.diagnosis_result_id
          AND user_id = auth.uid()
      )
    )
  );
