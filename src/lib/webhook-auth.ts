import { timingSafeEqual } from 'node:crypto';

/**
 * Webhooks that change access or billing state must fail closed. An unset
 * secret is a configuration error, never permission to accept a request.
 */
export function hasValidWebhookSecret(
  configuredSecret: string | undefined,
  suppliedSecret: unknown
) {
  if (!configuredSecret || typeof suppliedSecret !== 'string') return false;

  const expected = Buffer.from(configuredSecret);
  const supplied = Buffer.from(suppliedSecret);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

/**
 * Pending activations are for members who have not yet been linked. Importing
 * a member list must never revive cancelled or payment-failed accounts.
 */
export function canActivatePendingProfile(status: string | null | undefined) {
  return status === 'none' || status == null;
}
