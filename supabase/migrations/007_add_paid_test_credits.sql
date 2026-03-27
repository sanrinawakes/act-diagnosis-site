-- Add paid test credits field for referral code system
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS paid_test_credits integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code_used text DEFAULT NULL;
