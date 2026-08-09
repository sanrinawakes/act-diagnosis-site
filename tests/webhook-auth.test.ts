import { describe, expect, it } from 'vitest';
import {
  canActivatePendingProfile,
  hasValidWebhookSecret,
} from '../src/lib/webhook-auth';

describe('webhook authentication', () => {
  it('fails closed when the configured secret is missing', () => {
    expect(hasValidWebhookSecret('', 'presented-secret')).toBe(false);
    expect(hasValidWebhookSecret(undefined, 'presented-secret')).toBe(false);
  });

  it('accepts only the exact configured secret', () => {
    expect(hasValidWebhookSecret('webhook-secret', 'webhook-secret')).toBe(true);
    expect(hasValidWebhookSecret('webhook-secret', 'different-secret')).toBe(false);
    expect(hasValidWebhookSecret('webhook-secret', undefined)).toBe(false);
  });
});

describe('pending member activation', () => {
  it('only activates accounts that have not previously been linked', () => {
    expect(canActivatePendingProfile('none')).toBe(true);
    expect(canActivatePendingProfile(null)).toBe(true);
    expect(canActivatePendingProfile(undefined)).toBe(true);
    expect(canActivatePendingProfile('active')).toBe(false);
    expect(canActivatePendingProfile('cancelled')).toBe(false);
    expect(canActivatePendingProfile('payment_failed')).toBe(false);
  });
});
