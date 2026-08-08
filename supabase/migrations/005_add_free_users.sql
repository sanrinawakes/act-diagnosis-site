-- Free users table for tracking email-only users
CREATE TABLE IF NOT EXISTS public.free_users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text NOT NULL,
  chat_count_today integer NOT NULL DEFAULT 0,
  last_chat_date date NOT NULL DEFAULT CURRENT_DATE,
  diagnosis_completed boolean NOT NULL DEFAULT false,
  diagnosis_level integer,
  diagnosis_type_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index on email for quick lookup
CREATE INDEX IF NOT EXISTS idx_free_users_email ON public.free_users(email);

-- Free-user records contain email addresses. API routes use the service role,
-- which bypasses RLS, so no anon or authenticated table policy is permitted.
ALTER TABLE public.free_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.free_users FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
