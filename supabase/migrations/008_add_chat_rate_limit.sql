-- Add daily chat rate limit tracking columns to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS chat_count_today integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_chat_date date DEFAULT NULL;
