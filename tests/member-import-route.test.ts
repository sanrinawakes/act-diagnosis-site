import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MEMBER_IMPORT_SECRET = 'member-import-test-secret';
  return {
    createClient: vi.fn(),
    rpc: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

import { POST } from '../src/app/api/admin/import-members/route';

describe('POST /api/admin/import-members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: [{ status: 'applied' }], error: null });
    mocks.createClient.mockReturnValue({
      rpc: mocks.rpc,
    });
  });

  it('records each entitlement once without touching profiles or resetting activation state', async () => {
    const response = await POST(
      new NextRequest('https://acti.example.test/api/admin/import-members', {
        method: 'POST',
        body: JSON.stringify({
          secret: 'member-import-test-secret',
          members: [
            {
              email: 'member@example.test',
              started_at: '2026-01-01T00:00:00.000Z',
              renewal_cycle: 0,
              event_id: 'member-import-1',
            },
            {
              email: 'MEMBER@example.test',
              started_at: '2026-01-01T00:00:00.000Z',
              renewal_cycle: 0,
              event_id: 'member-import-duplicate',
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      results: { imported: 1, blocked: 0, skipped: 1, errors: 0 },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('apply_awakes_membership_event', {
      p_email: 'member@example.test',
      p_event_type: 'legacy_import',
      p_external_event_id: 'member-import-1',
      p_occurred_at: '2026-01-01T00:00:00.000Z',
      p_renewal_cycle: 0,
      p_source: 'myasp_import',
    });
  });

  it('reports but does not reactivate a cancelled legacy account', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ status: 'account_not_eligible', access_expires_at: null }],
      error: null,
    });
    const response = await POST(
      new NextRequest('https://acti.example.test/api/admin/import-members', {
        method: 'POST',
        body: JSON.stringify({
          secret: 'member-import-test-secret',
          members: [{
            email: 'member@example.test',
            started_at: '2026-01-01T00:00:00.000Z',
            renewal_cycle: 0,
            event_id: 'member-import-1',
          }],
        }),
      })
    );
    expect(await response.json()).toMatchObject({
      results: { imported: 0, blocked: 1, skipped: 0, errors: 0 },
    });
  });

  it('rejects a caller without the dedicated secret before writing an entitlement', async () => {
    const response = await POST(
      new NextRequest('https://acti.example.test/api/admin/import-members', {
        method: 'POST',
        body: JSON.stringify({
          secret: 'wrong-secret',
          members: [{ email: 'member@example.test' }],
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
