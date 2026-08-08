-- A member profile includes authorization and subscription fields. Browser
-- clients may read their own profile, but must never write it directly.
-- Display-name changes are mediated by /api/profile with a server-side allowlist.
REVOKE UPDATE ON TABLE public.profiles FROM anon, authenticated;

-- The original policy was broader than the browser needs. Removing it keeps a
-- fresh schema aligned with the production lock-down above.
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
