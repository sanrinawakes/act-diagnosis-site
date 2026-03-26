-- Add MyASP integration fields to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS myasp_customer_email text,
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'none'
    CHECK (subscription_status IN ('none', 'active', 'cancelled', 'payment_failed')),
  ADD COLUMN IF NOT EXISTS subscribed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- Index for MyASP email lookup
CREATE INDEX IF NOT EXISTS idx_profiles_myasp_email ON public.profiles(myasp_customer_email);
CREATE INDEX IF NOT EXISTS idx_profiles_subscription_status ON public.profiles(subscription_status);

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
