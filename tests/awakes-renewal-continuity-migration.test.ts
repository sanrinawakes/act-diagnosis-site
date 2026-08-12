import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/030_make_awakes_renewals_event_driven.sql'),
  'utf8'
);

describe('event-driven AWAKES renewal migration', () => {
  it('derives every future cycle from a unique paid event and preserves retry idempotency', () => {
    expect(source).toContain('DROP INDEX IF EXISTS public.awakes_membership_events_cycle_unique');
    expect(source).toContain('v_cycle := v_membership.renewal_cycle + 1');
    expect(source).toContain("greatest(v_membership.expires_at, p_occurred_at)");
    expect(source).toContain('WHERE source = v_source');
    expect(source).toContain("RETURN QUERY SELECT 'duplicate'::text, v_expires_at");
    expect(source).toContain('v_email, p_event_type, v_cycle, v_source');
  });
});
