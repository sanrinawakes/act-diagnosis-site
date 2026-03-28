-- Add chat session history columns
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_pinned boolean DEFAULT false;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_message_at timestamptz DEFAULT now();
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS message_count integer DEFAULT 0;
