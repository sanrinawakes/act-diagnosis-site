import { createHmac, randomInt } from 'node:crypto';

export const SUBSCRIPTION_CLAIM_CODE_LENGTH = 6;
export const SUBSCRIPTION_CLAIM_CODE_TTL_MINUTES = 15;
export const SUBSCRIPTION_CLAIM_MAX_ATTEMPTS = 5;

export function normalizeSubscriptionClaimEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isSubscriptionClaimEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export function createSubscriptionClaimCode() {
  return String(randomInt(0, 1_000_000)).padStart(
    SUBSCRIPTION_CLAIM_CODE_LENGTH,
    '0'
  );
}

export function hashSubscriptionClaimCode(params: {
  secret: string;
  userId: string;
  awakesEmail: string;
  code: string;
}) {
  return createHmac('sha256', params.secret)
    .update(`acti-subscription-claim:v1:${params.userId}:${params.awakesEmail}:${params.code}`)
    .digest('hex');
}

export function getSubscriptionClaimExpiry(now = new Date()) {
  return new Date(
    now.getTime() + SUBSCRIPTION_CLAIM_CODE_TTL_MINUTES * 60 * 1000
  ).toISOString();
}
