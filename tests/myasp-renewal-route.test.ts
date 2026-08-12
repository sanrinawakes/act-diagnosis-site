import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MYASP_WEBHOOK_SECRET = 'renewal-secret';
  return { createClient: vi.fn(), rpc: vi.fn() };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

import { POST } from '../src/app/api/myasp/renewal/route';

function request(body: Record<string, unknown>) {
  return new NextRequest('https://acti.example.test/api/myasp/renewal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/myasp/renewal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({
      data: [{ status: 'applied', access_expires_at: '2028-01-01T00:00:00.000Z' }],
      error: null,
    });
  });

  it('applies one identified paid renewal cycle', async () => {
    const response = await POST(request({
      secret: 'renewal-secret',
      mail: 'MEMBER@example.test',
      event_id: 'order-123',
      renewal_cycle: '1',
      source: 'awakes-renewal-qAknuAHw',
      occurred_at: '2026-06-01T00:00:00.000Z',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, action: 'renewed' });
    expect(mocks.rpc).toHaveBeenCalledWith('apply_awakes_membership_event', {
      p_email: 'member@example.test',
      p_event_type: 'renewal',
      p_external_event_id: 'order-123',
      p_occurred_at: '2026-06-01T00:00:00.000Z',
      p_renewal_cycle: 1,
      p_source: 'awakes-renewal-qAknuAHw',
    });
  });

  it('rejects missing order identity, invalid cycle, and invalid secret before writing', async () => {
    expect((await POST(request({ secret: 'renewal-secret', mail: 'm@example.test', renewal_cycle: 1 }))).status).toBe(400);
    expect((await POST(request({ secret: 'renewal-secret', mail: 'm@example.test', event_id: 'x', renewal_cycle: 0 }))).status).toBe(400);
    expect((await POST(request({ secret: 'wrong', mail: 'm@example.test', event_id: 'x', renewal_cycle: 1 }))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('is idempotent and fails closed if the initial membership is missing', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ status: 'duplicate', access_expires_at: '2028-01-01T00:00:00.000Z' }], error: null });
    const duplicate = await POST(request({ secret: 'renewal-secret', mail: 'm@example.test', event_id: 'x', renewal_cycle: 1 }));
    expect(await duplicate.json()).toMatchObject({ action: 'already_applied' });

    mocks.rpc.mockResolvedValueOnce({ data: [{ status: 'membership_missing', access_expires_at: null }], error: null });
    const missing = await POST(request({ secret: 'renewal-secret', mail: 'm@example.test', event_id: 'y', renewal_cycle: 1 }));
    expect(missing.status).toBe(409);
  });
});
