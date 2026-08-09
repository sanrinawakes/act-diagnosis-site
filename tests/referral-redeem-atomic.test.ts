import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('atomic referral redemption', () => {
  it('uses a row-locking database function instead of a read then update route', () => {
    const migration = read('supabase/migrations/022_make_referral_redemption_atomic.sql');
    const route = read('src/app/api/referral/redeem/route.ts');

    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("'already_used'::text");
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.redeem_referral_code');
    expect(route).toContain("rpc(\n      'redeem_referral_code'");
    expect(route).not.toContain(".from('profiles')\n      .update(");
  });
});
