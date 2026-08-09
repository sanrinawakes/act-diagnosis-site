import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getUserMock, updateMock, eqMock } = vi.hoisted(() => ({
  setupEnv: (() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://act-diagnosis-site.vercel.app';
  })(),
  getUserMock: vi.fn(),
  updateMock: vi.fn(),
  eqMock: vi.fn(),
}));

vi.mock('../src/lib/supabase-server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getUser: getUserMock },
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      update: updateMock,
    })),
  })),
}));

import { PATCH } from '../src/app/api/profile/route';

const request = (body: unknown, origin = 'https://act-diagnosis-site.vercel.app') =>
  new NextRequest('https://act-diagnosis-site.vercel.app/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });

describe('PATCH /api/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserMock.mockResolvedValue({
      data: { user: { id: '11111111-1111-4111-8111-111111111111' } },
      error: null,
    });
    eqMock.mockResolvedValue({ error: null });
    updateMock.mockReturnValue({ eq: eqMock });
  });

  it('updates only the signed-in member display name', async () => {
    const response = await PATCH(request({ display_name: '  山田 花子  ' }));

    expect(response.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: '山田 花子' })
    );
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('role');
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('subscription_status');
    expect(eqMock).toHaveBeenCalledWith('id', '11111111-1111-4111-8111-111111111111');
  });

  it('rejects unauthenticated callers before updating a profile', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const response = await PATCH(request({ display_name: '山田 花子' }));

    expect(response.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects cross-site requests before reading authentication', async () => {
    const response = await PATCH(request({ display_name: '山田 花子' }, 'https://example.invalid'));

    expect(response.status).toBe(403);
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('rejects oversized display names', async () => {
    const response = await PATCH(request({ display_name: 'a'.repeat(101) }));

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
