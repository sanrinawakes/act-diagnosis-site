import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MYASP_WEBHOOK_SECRET = 'payment-state-secret';
  return { createClient: vi.fn(), rpc: vi.fn() };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

import { POST } from '../src/app/api/myasp/payment-state/route';

function request(body: Record<string, unknown>) {
  return new NextRequest('https://acti.example.test/api/myasp/payment-state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/myasp/payment-state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({
      data: [{
        status: 'applied',
        membership_status: 'payment_failed',
        profiles_changed: 1,
        pending_changed: 1,
      }],
      error: null,
    });
  });

  it('suspends all AWAKES access from an authenticated payment failure', async () => {
    const response = await POST(request({
      secret: 'payment-state-secret',
      mail: 'MEMBER@example.test',
      state: 'payment_failed',
      event_id: 'order-1:attempt-1:failed',
      source: 'myasp-dZKxhi1v-univapay',
      occurred_at: '2026-08-12T03:00:00.000Z',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      action: 'access_suspended',
      membership_status: 'payment_failed',
      profiles_changed: 1,
      pending_changed: 1,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('apply_awakes_payment_state_event', {
      p_email: 'member@example.test',
      p_state: 'payment_failed',
      p_external_event_id: 'order-1:attempt-1:failed',
      p_occurred_at: '2026-08-12T03:00:00.000Z',
      p_source: 'myasp-dZKxhi1v-univapay',
    });
  });

  it('restores only through the explicit paid state and reports duplicates', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{
        status: 'duplicate',
        membership_status: 'active',
        profiles_changed: 0,
        pending_changed: 0,
      }],
      error: null,
    });

    const response = await POST(request({
      secret: 'payment-state-secret',
      mail: 'member@example.test',
      state: 'payment_restored',
      event_id: 'order-1:paid-2',
      source: 'myasp-dZKxhi1v-univapay',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'already_applied' });
  });

  it('fails closed for expired or missing memberships', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ status: 'term_expired', membership_status: 'expired' }],
      error: null,
    });
    const expired = await POST(request({
      secret: 'payment-state-secret',
      mail: 'member@example.test',
      state: 'payment_restored',
      event_id: 'paid-after-expiry',
      source: 'myasp-dZKxhi1v-univapay',
    }));
    expect(expired.status).toBe(409);

    mocks.rpc.mockResolvedValueOnce({
      data: [{ status: 'membership_missing', membership_status: 'missing' }],
      error: null,
    });
    const missing = await POST(request({
      secret: 'payment-state-secret',
      mail: 'member@example.test',
      state: 'payment_restored',
      event_id: 'paid-without-membership',
      source: 'myasp-dZKxhi1v-univapay',
    }));
    expect(missing.status).toBe(409);
  });

  it('rejects authentication or event identity errors before writing', async () => {
    expect((await POST(request({
      secret: 'wrong',
      mail: 'member@example.test',
      state: 'payment_failed',
      event_id: 'x',
      source: 'scenario',
    }))).status).toBe(401);
    expect((await POST(request({
      secret: 'payment-state-secret',
      mail: 'member@example.test',
      state: 'payment_failed',
      source: 'scenario',
    }))).status).toBe(400);
    expect((await POST(request({
      secret: 'payment-state-secret',
      mail: 'member@example.test',
      state: 'payment_failed',
      event_id: 'bad-time',
      source: 'scenario',
      occurred_at: 'not-a-date',
    }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
