-- pending_activations: MyASPの有効会員メールアドレスを格納するテーブル
-- 新規アカウント作成時に自動的にsubscription_statusをactiveにするために使用
CREATE TABLE IF NOT EXISTS public.pending_activations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text NOT NULL,
  source text NOT NULL DEFAULT 'myasp',
  activated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

-- emailカラムにUNIQUE制約（API側でlowercaseに正規化して格納する）
ALTER TABLE public.pending_activations ADD CONSTRAINT pending_activations_email_unique UNIQUE (email);

-- RLS有効化
ALTER TABLE public.pending_activations ENABLE ROW LEVEL SECURITY;

-- API routes use the service role, which bypasses RLS. Do not create a policy
-- here: a policy without TO service_role applies to anonymous callers too.
REVOKE ALL ON TABLE public.pending_activations FROM anon, authenticated;

-- Account activation is intentionally not automatic. The account holder must
-- complete the one-time code flow in migration 019 before paid access is set.
