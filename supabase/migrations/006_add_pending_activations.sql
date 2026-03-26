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

-- サービスロールのみフルアクセス
CREATE POLICY "Service role full access on pending_activations"
  ON public.pending_activations
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- profilesテーブルにINSERT時、pending_activationsをチェックして自動active化する関数
CREATE OR REPLACE FUNCTION public.check_pending_activation()
RETURNS TRIGGER AS $$
DECLARE
  pending_record RECORD;
BEGIN
  -- pending_activationsテーブルで未使用のメールを検索
  SELECT id INTO pending_record
  FROM public.pending_activations
  WHERE lower(email) = lower(NEW.email)
    AND activated = false
  LIMIT 1;

  -- マッチしたら自動的にsubscription_statusをactiveにする
  IF FOUND THEN
    NEW.subscription_status := 'active';
    NEW.is_active := true;
    NEW.subscribed_at := now();
    NEW.updated_at := now();

    -- pending_activationsを使用済みに更新
    UPDATE public.pending_activations
    SET activated = true, activated_at = now()
    WHERE id = pending_record.id;

    RAISE LOG 'Auto-activated subscription for email: %', NEW.email;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- profilesへのINSERT時にトリガーを発火
-- BEFORE INSERTを使うことで、INSERT前にNEWの値を変更できる
DROP TRIGGER IF EXISTS trigger_check_pending_activation ON public.profiles;
CREATE TRIGGER trigger_check_pending_activation
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.check_pending_activation();
