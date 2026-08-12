import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/031_enforce_awakes_payment_state.sql'),
  'utf8'
);

describe('AWAKES recurring-payment state migration', () => {
  it('records ordered and idempotent payment state events', () => {
    expect(migration).toContain('awakes_payment_state_events');
    expect(migration).toContain('UNIQUE (source, external_event_id)');
    expect(migration).toContain("p_occurred_at < v_membership.payment_state_updated_at");
    expect(migration).toContain("p_occurred_at = v_membership.payment_state_updated_at");
    expect(migration).toContain("RETURN QUERY SELECT 'stale'");
    expect(migration).toContain("RETURN QUERY SELECT 'duplicate'");
  });

  it('revokes every ACTI access path immediately on payment failure', () => {
    expect(migration).toContain("status = v_resulting_status");
    expect(migration).toContain('DELETE FROM public.pending_activations');
    expect(migration).toContain("ELSE 'payment_failed'");
    expect(migration).toContain('is_active = false');
    expect(migration).toContain('coalesce(is_internal_coaching_monitor, false) = false');
  });

  it('restores only an unexpired, non-cancelled membership', () => {
    expect(migration).toContain("v_membership.status = 'cancelled'");
    expect(migration).toContain("v_membership.expires_at <= now()");
    expect(migration).toContain("subscription_status = 'payment_failed'");
    expect(migration).toContain("RETURN QUERY SELECT 'term_expired'");
  });

  it('prevents initial-payment retries from bypassing a later failure', () => {
    expect(migration).toContain("v_current_status = 'payment_failed'");
    expect(migration).toContain("'account_not_eligible'::text");
    expect(migration).toContain('apply_awakes_membership_event_v030');
  });
});
