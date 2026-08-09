import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deleteTestAuthUser } from '../scripts/lib/test-account-cleanup.mjs';

function createAdmin({
  deleteResults,
  lookupResults,
}: {
  deleteResults: Array<{ error: { message: string; status: number } | null }>;
  lookupResults: Array<{
    data: { user: { id: string } | null };
    error: { message: string; status: number } | null;
  }>;
}) {
  return {
    auth: {
      admin: {
        deleteUser: vi
          .fn()
          .mockImplementation(() => Promise.resolve(deleteResults.shift())),
        getUserById: vi
          .fn()
          .mockImplementation(() => Promise.resolve(lookupResults.shift())),
      },
    },
  };
}

describe('test auth-user cleanup', () => {
  it.each([
    'scripts/smoke-coaching-chat.mjs',
    'scripts/evaluate-coaching-quality.mjs',
    'scripts/probe-coaching-image-latency.mjs',
    'scripts/e2e-coaching-browser.mjs',
    'scripts/verify-coaching-scope-live.mjs',
  ])('%s uses the verified retry helper', (script) => {
    const source = readFileSync(resolve(process.cwd(), script), 'utf8');
    expect(source).toContain("import { deleteTestAuthUser } from './lib/test-account-cleanup.mjs'");
    expect(source).toContain('deleteTestAuthUser({');
  });

  it('retries a transient deletion failure and verifies absence', async () => {
    const admin = createAdmin({
      deleteResults: [
        { error: { message: 'temporary failure', status: 500 } },
        { error: null },
      ],
      lookupResults: [
        { data: { user: null }, error: { message: 'not found', status: 404 } },
      ],
    });

    await deleteTestAuthUser({
      admin,
      userId: 'test-user',
      label: 'Test',
      retryDelayMs: 0,
    });

    expect(admin.auth.admin.deleteUser).toHaveBeenCalledTimes(2);
    expect(admin.auth.admin.getUserById).toHaveBeenCalledTimes(1);
  });

  it('accepts an already absent auth user', async () => {
    const admin = createAdmin({
      deleteResults: [
        { error: { message: 'not found', status: 404 } },
      ],
      lookupResults: [
        { data: { user: null }, error: { message: 'not found', status: 404 } },
      ],
    });

    await expect(
      deleteTestAuthUser({
        admin,
        userId: 'test-user',
        label: 'Test',
        retryDelayMs: 0,
      })
    ).resolves.toBeUndefined();
  });

  it('fails after the bounded retry count', async () => {
    const admin = createAdmin({
      deleteResults: Array.from({ length: 3 }, () => ({
        error: { message: 'still failing', status: 500 },
      })),
      lookupResults: [],
    });

    await expect(
      deleteTestAuthUser({
        admin,
        userId: 'test-user',
        label: 'Test',
        retryDelayMs: 0,
      })
    ).rejects.toThrow('after 3 attempts');
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledTimes(3);
  });
});
