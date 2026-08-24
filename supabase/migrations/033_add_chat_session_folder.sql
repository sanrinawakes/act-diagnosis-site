-- Add folder organization for chat sessions
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS folder text DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_folder
  ON chat_sessions (user_id, folder)
  WHERE folder IS NOT NULL;
