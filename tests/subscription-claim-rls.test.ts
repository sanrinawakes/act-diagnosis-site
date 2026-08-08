import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/019_secure_subscription_claims.sql'),
  'utf8'
);
const route = readFileSync(
  resolve(process.cwd(), 'src/app/api/claim-subscription/route.ts'),
  'utf8'
);

describe('subscription claim privilege boundary', () => {
  it('keeps challenges and the atomic claim function inaccessible to browser roles', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.subscription_claim_challenges FROM anon, authenticated;'
    );
    expect(migration).toContain('FOR UPDATE;');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.consume_verified_subscription_claim(uuid, text, text, integer)\n  TO service_role;'
    );
  });

  it('does not directly grant a profile from a supplied email address', () => {
    expect(route).toContain("action === 'verify_code'");
    expect(route).toContain("'consume_verified_subscription_claim'");
    expect(route).not.toContain(".from('profiles')\n      .update({\n        subscription_status: 'active'");
  });
});
