import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MYASP_WEBHOOK_SECRET = 'myasp-cancel-test-secret';
  return {
    createClient: vi.fn(),
    removePending: vi.fn(),
    findPrimaryProfile: vi.fn(),
    findMyaspProfile: vi.fn(),
    deactivateProfile: vi.fn(),
    sendDeactivationEmail: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/email', () => ({
  sendDeactivationEmail: mocks.sendDeactivationEmail,
}));

import { POST } from '../src/app/api/myasp/cancel/route';

type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  subscription_status: string;
  is_active: boolean;
};

function configureClient(primaryProfile: Profile | null) {
  mocks.createClient.mockReturnValue({
    from(table: string) {
      if (table === 'pending_activations') {
        return {
          delete() {
            return { eq: mocks.removePending };
          },
        };
      }

      if (table !== 'profiles') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select() {
          return {
            eq(column: string) {
              return {
                single: column === 'email'
                  ? mocks.findPrimaryProfile
                  : mocks.findMyaspProfile,
              };
            },
          };
        },
        update() {
          return {
            eq() {
              return {
                or() {
                  return {
                    select() {
                      return { maybeSingle: mocks.deactivateProfile };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  });
  mocks.findPrimaryProfile.mockResolvedValue(
    primaryProfile
      ? { data: primaryProfile, error: null }
      : { data: null, error: { message: 'not found' } }
  );
  mocks.findMyaspProfile.mockResolvedValue({ data: null, error: null });
}

function cancellationRequest(secret = 'myasp-cancel-test-secret') {
  return new NextRequest('https://acti.example.test/api/myasp/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mail: 'member@example.test', secret }),
  });
}

describe('POST /api/myasp/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removePending.mockResolvedValue({ error: null });
    mocks.deactivateProfile.mockResolvedValue({ data: null, error: null });
    mocks.sendDeactivationEmail.mockResolvedValue({ success: true });
  });

  it('revokes a pending entitlement even before an ACTI account exists', async () => {
    configureClient(null);

    const response = await POST(cancellationRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      action: 'pending_entitlement_revoked',
    });
    expect(mocks.removePending).toHaveBeenCalledWith('email', 'member@example.test');
    expect(mocks.sendDeactivationEmail).not.toHaveBeenCalled();
  });

  it('does not resend a deactivation email for a duplicate cancellation', async () => {
    configureClient({
      id: '97dcf0b9-bda9-485f-b2cd-bcf5996f1c8c',
      email: 'member@example.test',
      display_name: 'Member',
      subscription_status: 'cancelled',
      is_active: false,
    });

    const response = await POST(cancellationRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      action: 'already_deactivated',
    });
    expect(mocks.sendDeactivationEmail).not.toHaveBeenCalled();
  });

  it('sends one deactivation email only after an active account is changed', async () => {
    const profile = {
      id: 'b58afc08-900f-487c-8215-8ee94d3ed0b8',
      email: 'member@example.test',
      display_name: 'Member',
      subscription_status: 'active',
      is_active: true,
    };
    configureClient(profile);
    mocks.deactivateProfile.mockResolvedValue({
      data: {
        id: profile.id,
        email: profile.email,
        display_name: profile.display_name,
      },
      error: null,
    });

    const response = await POST(cancellationRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      action: 'deactivated',
    });
    expect(mocks.sendDeactivationEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid webhook secret before changing data', async () => {
    configureClient(null);

    const response = await POST(cancellationRequest('wrong-secret'));

    expect(response.status).toBe(401);
    expect(mocks.removePending).not.toHaveBeenCalled();
    expect(mocks.sendDeactivationEmail).not.toHaveBeenCalled();
  });
});
