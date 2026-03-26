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

-- Allow anonymous access for free users (no auth required)
ALTER TABLE public.free_users ENABLE ROW LEVEL SECURITY;

-- Policy: anyone can insert (new free user)
CREATE POLICY "Anyone can create free user" ON public.free_users
  FOR INSERT WITH CHECK (true);

-- Policy: Service role can do anything
CREATE POLICY "Service role can do anything" ON public.free_users
  FOR ALL USING (auth.role() = 'service_role');

-- Allow anon to select free_users (for the free version to work without auth)
CREATE POLICY "Anon can select free_users" ON public.free_users
  FOR SELECT USING (true);

-- Allow anon to update free_users (for the free version to work without auth)
CREATE POLICY "Anon can update free_users" ON public.free_users
  FOR UPDATE USING (true);

NOTIFY pgrst, 'reload schema';
