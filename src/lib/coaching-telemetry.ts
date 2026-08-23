import { createHash } from 'node:crypto';

export function createCoachingSessionCorrelationId(
  sessionId: string | null | undefined
) {
  if (!sessionId) return null;
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}
