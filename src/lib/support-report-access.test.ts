import { describe, it, expect } from 'vitest';
import { reportAuthorized, reportWindow, redactSupportReportMessage } from './support-report-access';
describe('read-only report boundary', () => {
  const secret = 'x'.repeat(64);
  it('requires the separate report credential', () => {
    expect(reportAuthorized('Bearer ' + secret, secret)).toBe(true);
    for (const value of [null, '', 'Bearer other', 'Basic ' + secret, 'Bearer ' + secret + 'x']) expect(reportAuthorized(value, secret)).toBe(false);
    expect(reportAuthorized('Bearer short', 'short')).toBe(false);
    expect(reportAuthorized('Bearer ' + secret, undefined)).toBe(false);
  });
  it('bounds report history and rejects malformed or future windows', () => {
    const now = Date.parse('2026-09-16T18:00:00Z');
    expect(reportWindow(null, null, now)).toEqual({ since: '2026-09-15T18:00:00.000Z', until: '2026-09-16T18:00:00.000Z' });
    expect(reportWindow('invalid', null, now)).toBeNull();
    expect(reportWindow('2020-01-01', null, now)).toBeNull();
    expect(reportWindow(null, '2099-01-01', now)).toBeNull();
    expect(reportWindow('2026-09-16T18:00:00Z', null, now)).toBeNull();
  });
});

it('omits technical diagnostics and email addresses from report content', () => {
  const value = '質問\n----- ACTI SUPPORT TECHNICAL CONTEXT -----\nprivate diagnostic\n----- ACTI SUPPORT REPLY LOG -----\n送信者: someone@example.com\n本文: 回答';
  const actual = redactSupportReportMessage(value);
  expect(actual).toContain('質問'); expect(actual).toContain('本文: 回答'); expect(actual).not.toContain('private diagnostic'); expect(actual).not.toContain('someone@example.com');
});
