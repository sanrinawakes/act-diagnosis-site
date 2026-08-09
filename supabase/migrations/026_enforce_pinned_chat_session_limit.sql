-- The API checks this limit for convenience, but concurrent requests can pass
-- the same count. The database is the final authority.
CREATE OR REPLACE FUNCTION public.enforce_pinned_chat_session_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_pinned_count integer;
BEGIN
  IF NEW.is_pinned IS NOT TRUE
     OR (TG_OP = 'UPDATE' AND OLD.is_pinned IS TRUE) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text));
  SELECT count(*)
  INTO v_pinned_count
  FROM public.chat_sessions
  WHERE user_id = NEW.user_id
    AND is_pinned IS TRUE;

  IF v_pinned_count >= 100 THEN
    RAISE EXCEPTION 'A member may pin at most 100 chat sessions';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_enforce_pinned_chat_session_limit ON public.chat_sessions;
CREATE TRIGGER trigger_enforce_pinned_chat_session_limit
BEFORE INSERT OR UPDATE OF is_pinned ON public.chat_sessions
FOR EACH ROW EXECUTE FUNCTION public.enforce_pinned_chat_session_limit();
