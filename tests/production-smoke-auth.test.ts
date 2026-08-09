import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const smokeSource = readFileSync(
  resolve(process.cwd(), 'scripts/smoke-coaching-chat.mjs'),
  'utf8'
);
const freeValidationSource = readFileSync(
  resolve(process.cwd(), 'src/lib/free-chat-validation.ts'),
  'utf8'
);
const cleanupSource = readFileSync(
  resolve(process.cwd(), 'scripts/lib/test-account-cleanup.mjs'),
  'utf8'
);

describe('production coaching smoke authentication', () => {
  it('creates and signs in a dedicated authenticated test user', () => {
    expect(smokeSource).toContain('auth.admin.createUser');
    expect(smokeSource).toContain('auth.signInWithPassword');
    expect(smokeSource).toContain('Authorization: `Bearer ${accessToken}`');
  });

  it('removes auth, profile, free-user, and quota test data', () => {
    expect(smokeSource).toContain(".from('free_users')");
    expect(smokeSource).toContain('deleteTestAuthUser');
    expect(cleanupSource).toContain('auth.admin.deleteUser');
    expect(cleanupSource).toContain('auth.admin.getUserById');
    expect(smokeSource).toContain(".from('profiles')");
    expect(smokeSource).toContain(".from('free_coaching_daily_usage')");
    expect(smokeSource).toContain('profileCount !== 0');
    expect(smokeSource).toContain('quotaCount !== 0');
  });

  it('keeps its long-history scenario inside the free API request boundary', () => {
    const maxMessages = Number(
      freeValidationSource.match(/MAX_FREE_REQUEST_MESSAGES = (\d+)/)?.[1]
    );
    const pairCount = Number(
      smokeSource.match(/index < (\d+); index \+= 1/)?.[1]
    );

    expect(maxMessages).toBeGreaterThan(24);
    expect(pairCount * 2 + 1).toBeLessThanOrEqual(maxMessages);
    expect(pairCount * 2 + 1).toBeGreaterThan(24);
  });
});
