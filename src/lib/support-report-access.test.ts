import { describe, it, expect } from 'vitest';
import { reportAuthorized, reportWindow } from './support-report-access';
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
