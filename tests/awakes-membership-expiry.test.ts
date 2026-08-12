import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/028_enforce_awakes_membership_expiry.sql'),
  'utf8'
);

describe('AWAKES membership expiry migration', () => {
  it('fails closed for undated or expired active profiles and pending claims', () => {
    expect(migration).toContain('awakes_access_expires_at IS NULL OR awakes_access_expires_at <= now()');
    expect(migration).toContain('v_pending.access_expires_at IS NULL');
    expect(migration).toContain("subscription_status = 'expired'");
  });

  it('persists each scheduled expiry run for production continuity checks', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.awakes_access_cron_runs');
    expect(migration).toContain('idx_awakes_access_cron_runs_created_at');
    expect(migration).toContain('ALTER TABLE public.awakes_access_cron_runs ENABLE ROW LEVEL SECURITY');
  });

  it('deduplicates both webhook retries and duplicate purchases for the same renewal year', () => {
    expect(migration).toContain('UNIQUE (source, external_event_id)');
    expect(migration).toContain('awakes_membership_events_cycle_unique');
    expect(migration).toContain("WHERE event_type = 'renewal'");
  });

  it('does not let a matching ACTI email bypass the verification-code flow on initial payment', () => {
    expect(migration).toContain("p_event_type = 'legacy_import' AND lower(email) = v_email");
    expect(migration).not.toContain("p_event_type = 'initial' AND lower(email) = v_email");
  });

  it('does not let an initial retry or legacy import reopen a cancelled account', () => {
    expect(migration).toContain("p_event_type <> 'renewal'");
    expect(migration).toContain("subscription_status IN ('cancelled', 'payment_failed')");
    expect(migration).toContain("'account_not_eligible'::text");
  });
});
