import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  createSubscriptionClaimCode,
  getSubscriptionClaimExpiry,
  hashSubscriptionClaimCode,
  SUBSCRIPTION_CLAIM_CODE_LENGTH,
} from '../src/lib/subscription-claim';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.SUBSCRIPTION_CLAIM_SECRET = 'subscription-claim-test-secret';
  process.env.RESEND_API_KEY = 'resend-test-key';
  return {
    createClient: vi.fn(),
    getUser: vi.fn(),
    profileMaybeSingle: vi.fn(),
    pendingMaybeSingle: vi.fn(),
    challengeUpsert: vi.fn(),
    challengeDelete: vi.fn(),
    rpc: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

import { POST } from '../src/app/api/claim-subscription/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'member@example.test';

describe('subscription claim code helpers', () => {
  it('creates a fixed-width numeric one-time code', () => {
    expect(createSubscriptionClaimCode()).toMatch(
      new RegExp(`^\\d{${SUBSCRIPTION_CLAIM_CODE_LENGTH}}$`)
    );
  });

  it('binds a code hash to both account and MyASP email', () => {
    const base = {
      secret: 'secret',
      userId: USER_ID,
      awakesEmail: EMAIL,
      code: '123456',
    };
    expect(hashSubscriptionClaimCode(base)).not.toBe(
      hashSubscriptionClaimCode({ ...base, userId: '22222222-2222-4222-8222-222222222222' })
    );
    expect(hashSubscriptionClaimCode(base)).not.toBe(
      hashSubscriptionClaimCode({ ...base, awakesEmail: 'other@example.test' })
    );
  });

  it('expires a sent code after the configured window', () => {
    expect(getSubscriptionClaimExpiry(new Date('2026-08-08T00:00:00.000Z'))).toBe(
      '2026-08-08T00:15:00.000Z'
    );
  });
});

describe('POST /api/claim-subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    mocks.profileMaybeSingle.mockResolvedValue({
      data: { subscription_status: 'none' },
      error: null,
    });
    mocks.pendingMaybeSingle.mockResolvedValue({
      data: { email: EMAIL, activated: false },
      error: null,
    });
    mocks.challengeUpsert.mockResolvedValue({ error: null });
    mocks.challengeDelete.mockReturnValue({
      eq: () => ({
        eq: () => ({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }),
    });
    mocks.rpc.mockResolvedValue({ data: [{ status: 'claimed' }], error: null });
    mocks.createClient.mockImplementation((_url: string, key: string) => {
      if (key === 'anon-key') {
        return { auth: { getUser: mocks.getUser } };
      }
      return createAdminClient();
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });

  it('does not retain the old email-only activation path', async () => {
    const response = await POST(createRequest({ email: EMAIL }));
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('sends a code only after a matching unclaimed record is found', async () => {
    const response = await POST(createRequest({ action: 'request_code', email: EMAIL }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('code_sent');
    expect(mocks.challengeUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        awakes_email: EMAIL,
        code_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      { onConflict: 'user_id,awakes_email' }
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('does not send an email when the provided MyASP email has no unclaimed record', async () => {
    mocks.pendingMaybeSingle.mockResolvedValue({ data: null, error: null });

    const response = await POST(createRequest({ action: 'request_code', email: EMAIL }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('unavailable');
    expect(mocks.challengeUpsert).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('uses the atomic verification RPC instead of directly updating a profile', async () => {
    const response = await POST(
      createRequest({ action: 'verify_code', email: EMAIL, code: '123456' })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('claimed');
    expect(mocks.rpc).toHaveBeenCalledWith(
      'consume_verified_subscription_claim',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_awakes_email: EMAIL,
        p_code_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        p_max_attempts: 5,
      })
    );
  });

  it('rejects malformed codes before querying the database', async () => {
    const response = await POST(
      createRequest({ action: 'verify_code', email: EMAIL, code: 'abc' })
    );
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

function createRequest(body: Record<string, unknown>) {
  return new NextRequest('https://act-diagnosis-site.vercel.app/api/claim-subscription', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: 'Bearer user-access-token',
    },
    body: JSON.stringify(body),
  });
}

function createAdminClient() {
  return {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.profileMaybeSingle }),
          }),
        };
      }
      if (table === 'pending_activations') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({ maybeSingle: mocks.pendingMaybeSingle }),
            }),
          }),
        };
      }
      if (table === 'subscription_claim_challenges') {
        return {
          upsert: mocks.challengeUpsert,
          delete: () => mocks.challengeDelete(),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: mocks.rpc,
  };
}
