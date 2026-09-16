import { createHash, timingSafeEqual } from 'node:crypto';
export function reportAuthorized(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(secret));
}
export function reportWindow(start: string | null, end: string | null, now = Date.now()) {
  const until = end ? Date.parse(end) : now;
  const since = start ? Date.parse(start) : until - 86400000;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until || until > now + 60000 || since < now - 7 * 86400000 || until - since > 2 * 86400000) return null;
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}
