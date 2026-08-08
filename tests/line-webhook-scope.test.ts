import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'src/app/api/line/webhook/route.ts'),
  'utf8'
);

describe('LINE webhook cost and scope guard', () => {
  it('blocks oversized, out-of-scope, and burst messages before calling the provider', () => {
    const scopeIndex = source.indexOf('const scope = classifyCoachingScope');
    const rateIndex = source.indexOf('const rate = await reserveLineMessageRate');
    const providerIndex = source.indexOf('const aiResponse = await generateCoachingResponse');

    expect(source).toContain('const MAX_LINE_MESSAGE_CHARS = 2000');
    expect(source).toContain('if (userText.length > MAX_LINE_MESSAGE_CHARS)');
    expect(scopeIndex).toBeGreaterThan(-1);
    expect(rateIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(rateIndex);
    expect(providerIndex).toBeGreaterThan(scopeIndex);
    expect(source).toContain('短時間に連続して送信されています。');
    expect(source).toContain("if (scope.decision === 'blocked')");
    expect(source).toContain('textMessage(COACHING_SCOPE_GUIDANCE)');
  });
});
