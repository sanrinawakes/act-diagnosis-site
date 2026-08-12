import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'src/app/api/free/chat/route.ts'),
  'utf8'
);

describe('free chat scope guard', () => {
  it('stops non-coaching requests before quota reservation or provider generation', () => {
    const scopeIndex = source.indexOf('const scopeResult = classifyCoachingScope');
    const quotaIndex = source.indexOf('let quotaReservation');
    const providerIndex = source.indexOf('const result = await generateCoachingText');

    expect(scopeIndex).toBeGreaterThan(-1);
    expect(quotaIndex).toBeGreaterThan(scopeIndex);
    expect(providerIndex).toBeGreaterThan(scopeIndex);
    expect(source).toContain("if (scopeResult.decision === 'blocked')");
    expect(source).toContain('COACHING_SCOPE_GUIDANCE');
    expect(source).toContain("finishReason: 'SCOPE_BLOCKED'");
  });

  it('checks former-member status before any free quota or AI work', () => {
    const accessIndex = source.indexOf('isFormerAwakesMemberWithoutAccess(accessProfile)');
    const quotaIndex = source.indexOf('let quotaReservation');
    const providerIndex = source.indexOf('const result = await generateCoachingText');
    expect(accessIndex).toBeGreaterThan(-1);
    expect(quotaIndex).toBeGreaterThan(accessIndex);
    expect(providerIndex).toBeGreaterThan(accessIndex);
  });
});
