import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'src/app/api/line/webhook/route.ts'),
  'utf8'
);

describe('LINE webhook cost and scope guard', () => {
  it('blocks oversized, out-of-scope, burst, and monthly over-limit messages before calling the provider', () => {
    const scopeIndex = source.indexOf('const scope = classifyCoachingScope');
    const rateIndex = source.indexOf('const rate = await reserveLineMessageRate');
    const quotaIndex = source.indexOf('quotaReservation = await reserveMonthlyQuota');
    const providerIndex = source.indexOf('const aiResponse = await generateCoachingResponse');

    expect(source).toContain('const MAX_LINE_MESSAGE_CHARS = 2000');
    expect(source).toContain('if (userText.length > MAX_LINE_MESSAGE_CHARS)');
    expect(scopeIndex).toBeGreaterThan(-1);
    expect(rateIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(rateIndex);
    expect(providerIndex).toBeGreaterThan(scopeIndex);
    expect(quotaIndex).toBeGreaterThan(scopeIndex);
    expect(providerIndex).toBeGreaterThan(quotaIndex);
    expect(source).toContain('短時間に連続して送信されています。');
    expect(source).toContain("if (scope.decision === 'blocked')");
    expect(source).toContain('textMessage(COACHING_SCOPE_GUIDANCE)');
    expect(source).toContain('buildMonthlyQuotaError(MONTHLY_COACHING_LIMIT)');
    expect(source).toContain('releaseMonthlyQuota({');
  });

  it('never creates a LINE profile and requires a current AWAKES entitlement before using AI', () => {
    const accessIndex = source.indexOf('if (!profile || !hasCoachingAccess(profile))');
    const providerIndex = source.indexOf('const aiResponse = await generateCoachingResponse');

    expect(source).not.toContain('auth.admin.createUser');
    expect(source).not.toContain('@line.placeholder');
    expect(source).toContain('awakes_access_expires_at');
    expect(accessIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(accessIndex);
  });
});
