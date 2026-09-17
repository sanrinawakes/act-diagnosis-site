import { createHash, timingSafeEqual } from 'node:crypto';
export function supportAccessScope(header: string | null, adminSecret?: string, workerSecret?: string) {
  if (adminSecret && workerSecret === adminSecret) return null;
  if (!header?.startsWith('Bearer ')) return null;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const supplied = hash(header.slice(7));
  if (adminSecret && timingSafeEqual(supplied, hash(adminSecret))) return 'admin';
  if (workerSecret && workerSecret.length >= 32 && timingSafeEqual(supplied, hash(workerSecret))) return 'worker';
  return null;
}
export function supportWorkerActionError(body: Record<string, unknown>) {
  const action = body.action;
  if (!['claim', 'heartbeat', 'release', 'reply', 'quality_claim', 'quality_heartbeat', 'quality_release', 'quality_resolve'].includes(String(action))) return 'Worker action is not permitted';
  if (action === 'claim' || action === 'reply' || action === 'quality_claim') {
    if (typeof body.expected_updated_at !== 'string' || !Number.isFinite(Date.parse(body.expected_updated_at))) return 'Worker requires the current ticket revision';
  }
  if (action === 'reply' && (!['usage', 'technical'].includes(String(body.classification)) || !['usage_answer', 'progress', 'technical_fix'].includes(String(body.resolution_kind)))) return 'Worker reply type is not permitted';
  if (action === 'quality_resolve' && body.resolution_kind !== 'technical_fix') return 'Worker requires verified technical release evidence';
  if (['to', 'email', 'url', 'sql', 'decision', 'user_id'].some(key => key in body)) return 'Worker cannot choose recipients or account operations';
  return null;
}
