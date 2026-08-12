import { describe, expect, it } from 'vitest';
import {
  hasActiveAwakesAccess,
  hasCoachingAccess,
  hasPaidDiagnosisAccess,
  isFormerAwakesMemberWithoutAccess,
} from '../src/lib/coaching-access';

const now = new Date('2026-08-12T00:00:00.000Z');

describe('AWAKES coaching access', () => {
  it('allows a current paid membership and rejects missing, invalid, or expired terms', () => {
    const base = { role: 'member', subscription_status: 'active', is_active: true, paid_test_credits: 0 };
    expect(hasActiveAwakesAccess({ ...base, awakes_access_expires_at: '2026-08-13T00:00:00.000Z' }, now)).toBe(true);
    expect(hasActiveAwakesAccess({ ...base, awakes_access_expires_at: '2026-08-12T00:00:00.000Z' }, now)).toBe(false);
    expect(hasActiveAwakesAccess({ ...base, awakes_access_expires_at: null }, now)).toBe(false);
    expect(hasActiveAwakesAccess({ ...base, awakes_access_expires_at: 'not-a-date' }, now)).toBe(false);
    expect(hasActiveAwakesAccess({ ...base, is_active: false, awakes_access_expires_at: '2026-09-01T00:00:00.000Z' }, now)).toBe(false);
  });

  it('allows admins but never lets a diagnosis credit unlock coaching', () => {
    expect(hasCoachingAccess({ role: 'admin' }, now)).toBe(true);
    expect(hasCoachingAccess({ role: 'member', paid_test_credits: 1 }, now)).toBe(false);
    expect(hasCoachingAccess({ role: 'member', paid_test_credits: 0 }, now)).toBe(false);
    expect(hasPaidDiagnosisAccess({ role: 'member', paid_test_credits: 1 }, now)).toBe(true);
  });

  it('blocks known former members from falling back to the free bot', () => {
    expect(isFormerAwakesMemberWithoutAccess({
      role: 'member',
      subscription_status: 'active',
      is_active: true,
      awakes_access_started_at: '2025-01-01T00:00:00.000Z',
      awakes_access_expires_at: '2026-01-01T00:00:00.000Z',
    }, now)).toBe(true);
    expect(isFormerAwakesMemberWithoutAccess({ role: 'member', subscription_status: 'expired' }, now)).toBe(true);
    expect(isFormerAwakesMemberWithoutAccess({ role: 'member', subscription_status: 'none' }, now)).toBe(false);
  });
});
