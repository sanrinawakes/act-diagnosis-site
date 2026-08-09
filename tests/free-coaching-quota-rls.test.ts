import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/018_add_free_coaching_daily_quota.sql'),
  'utf8'
);

describe('free coaching quota database boundary', () => {
  it('keeps daily reservations inaccessible to browser roles', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.free_coaching_daily_usage FROM anon, authenticated;'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.reserve_free_coaching_daily_usage(uuid, uuid, date, integer)\n  TO service_role;'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.release_free_coaching_daily_usage(uuid, uuid, date, integer)\n  TO service_role;'
    );
  });

  it('serializes each users reservation check with a profile row lock', () => {
    const lockCount = (migration.match(/FOR UPDATE;/g) || []).length;
    expect(lockCount).toBeGreaterThanOrEqual(2);
    expect(migration).toContain('request_id uuid PRIMARY KEY');
  });
});
