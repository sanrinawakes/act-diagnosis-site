-- A browser can retry after a network interruption. The same form submission
-- must result in at most one ticket, one operator notification, and one receipt.
ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS submission_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_user_submission_key_unique
  ON public.support_tickets(user_id, submission_key)
  WHERE submission_key IS NOT NULL;
