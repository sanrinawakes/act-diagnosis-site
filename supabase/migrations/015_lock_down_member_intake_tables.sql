-- These tables contain email addresses and must only be reachable through
-- server routes that use the service role. Service-role requests bypass RLS;
-- policies without an explicit role apply to anon and authenticated callers.

ALTER TABLE public.free_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can create free user" ON public.free_users;
DROP POLICY IF EXISTS "Service role can do anything" ON public.free_users;
DROP POLICY IF EXISTS "Anon can select free_users" ON public.free_users;
DROP POLICY IF EXISTS "Anon can update free_users" ON public.free_users;
REVOKE ALL ON TABLE public.free_users FROM anon, authenticated;

ALTER TABLE public.pending_activations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on pending_activations"
  ON public.pending_activations;
REVOKE ALL ON TABLE public.pending_activations FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
