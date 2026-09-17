import { createHash, timingSafeEqual } from 'node:crypto';
export const DEFAULT_SUPPORT_AUTOMATION_START_AT = '2026-07-25T00:00:00.000Z';
export function supportAutomationStartAt(configured?: string | null) {
  const timestamp = Date.parse(configured || DEFAULT_SUPPORT_AUTOMATION_START_AT);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : DEFAULT_SUPPORT_AUTOMATION_START_AT;
}
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

export function redactSupportReportMessage(value: unknown) {
  const text = String(value || '');
  const technical = text.indexOf('----- ACTI SUPPORT TECHNICAL CONTEXT -----');
  const replies = text.indexOf('----- ACTI SUPPORT REPLY LOG -----');
  const withoutTechnical = technical < 0 ? text : text.slice(0, technical) + (replies > technical ? text.slice(replies) : '');
  return withoutTechnical.replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[メールアドレス省略]').replace(/(?:sk-proj-|ghp_|gho_|github_pat_|ya29\.)[A-Za-z0-9_.-]{16,}/g, '[秘密情報省略]');
}
