import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MEMBER_IMPORT_SECRET = 'member-import-test-secret';
  return {
    createClient: vi.fn(),
    upsert: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

import { POST } from '../src/app/api/admin/import-members/route';

describe('POST /api/admin/import-members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.createClient.mockReturnValue({
      from(table: string) {
        if (table !== 'pending_activations') {
          throw new Error(`Unexpected table ${table}`);
        }
        return { upsert: mocks.upsert };
      },
    });
  });

  it('records each entitlement once without touching profiles or resetting activation state', async () => {
    const response = await POST(
      new NextRequest('https://acti.example.test/api/admin/import-members', {
        method: 'POST',
        body: JSON.stringify({
          secret: 'member-import-test-secret',
          emails: ['member@example.test', 'MEMBER@example.test'],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      results: { imported: 1, skipped: 1, errors: 0 },
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      { email: 'member@example.test', source: 'myasp_import' },
      { onConflict: 'email' }
    );
  });

  it('rejects a caller without the dedicated secret before writing an entitlement', async () => {
    const response = await POST(
      new NextRequest('https://acti.example.test/api/admin/import-members', {
        method: 'POST',
        body: JSON.stringify({
          secret: 'wrong-secret',
          emails: ['member@example.test'],
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
