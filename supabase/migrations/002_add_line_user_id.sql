-- Add LINE user ID column to profiles table for LINE Messaging API integration
-- This allows linking LINE users to the existing profile system

-- Add line_user_id column
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS line_user_id TEXT UNIQUE;

-- Create index for fast lookup by LINE user ID
CREATE INDEX IF NOT EXISTS idx_profiles_line_user_id
ON profiles (line_user_id)
WHERE line_user_id IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN profiles.line_user_id IS 'LINE Messaging API user ID (e.g., U1234567890abcdef)';
