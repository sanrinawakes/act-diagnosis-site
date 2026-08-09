import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'),
  'utf8'
);

describe('quality evaluator authentication contract', () => {
  it('checks the Origin guard separately from unauthenticated access', () => {
    expect(source).toContain('API防御: Originなし・認証なしは403');
    expect(source).toContain('originlessUnauthorized.status === 403');
    expect(source).toContain('API防御: 許可Origin・認証なしは401');
    expect(source).toContain('unauthorized.status === 401');
    expect(source).toContain('Origin: new URL(baseUrl).origin');
  });
});
