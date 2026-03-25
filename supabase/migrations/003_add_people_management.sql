-- 人材管理テーブル（管理者用、最大100名分）
CREATE TABLE IF NOT EXISTS people_management (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  type_code VARCHAR(3) NOT NULL,
  consciousness_level INTEGER NOT NULL CHECK (consciousness_level >= 1 AND consciousness_level <= 6),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS有効化
ALTER TABLE people_management ENABLE ROW LEVEL SECURITY;

-- 管理者のみアクセス可能
CREATE POLICY "Admins can do everything on people_management"
  ON people_management
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- 100件制限のトリガー
CREATE OR REPLACE FUNCTION check_people_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM people_management) >= 100 THEN
    RAISE EXCEPTION 'Maximum number of people entries (100) reached';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_people_limit
  BEFORE INSERT ON people_management
  FOR EACH ROW
  EXECUTE FUNCTION check_people_limit();
