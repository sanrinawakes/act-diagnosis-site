import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.CRON_SECRET = 'cron-secret';
  return { createClient: vi.fn(), rpc: vi.fn(), auditInsert: vi.fn() };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

import { GET } from '../src/app/api/cron/awakes-access/route';

describe('GET /api/cron/awakes-access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({
      rpc: mocks.rpc,
      from: vi.fn(() => ({
        insert: mocks.auditInsert,
      })),
    });
    mocks.auditInsert.mockReturnValue({
      select: () => ({
        single: vi.fn().mockResolvedValue({
          data: { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-08-12T00:00:00Z' },
          error: null,
        }),
      }),
    });
    mocks.rpc.mockResolvedValue({
      data: [{ memberships_expired: 2, profiles_deactivated: 2, pending_revoked: 1 }],
      error: null,
    });
  });

  it('requires the cron bearer secret', async () => {
    const response = await GET(new NextRequest('https://acti.example.test/api/cron/awakes-access'));
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('expires memberships through one atomic database function', async () => {
    const response = await GET(new NextRequest('https://acti.example.test/api/cron/awakes-access', {
      headers: { authorization: 'Bearer cron-secret' },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      run_id: '11111111-1111-4111-8111-111111111111',
      profiles_deactivated: 2,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('expire_awakes_memberships');
    expect(mocks.auditInsert).toHaveBeenCalledWith({
      status: 'succeeded',
      memberships_expired: 2,
      profiles_deactivated: 2,
      pending_revoked: 1,
    });
  });

  it('fails the run if its database audit record cannot be saved', async () => {
    mocks.auditInsert.mockReturnValueOnce({
      select: () => ({
        single: vi.fn().mockResolvedValue({ data: null, error: { message: 'write failed' } }),
      }),
    });
    const response = await GET(new NextRequest('https://acti.example.test/api/cron/awakes-access', {
      headers: { authorization: 'Bearer cron-secret' },
    }));
    expect(response.status).toBe(500);
  });

  it('records an expiry-function failure without exposing customer data', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    const response = await GET(new NextRequest('https://acti.example.test/api/cron/awakes-access', {
      headers: { authorization: 'Bearer cron-secret' },
    }));
    expect(response.status).toBe(500);
    expect(mocks.auditInsert).toHaveBeenCalledWith({ status: 'failed' });
  });
});
