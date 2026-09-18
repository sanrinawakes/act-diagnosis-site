import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MYASP_WEBHOOK_SECRET = 'myasp-cancel-test-secret';
  return {
    createClient: vi.fn(),
    removePending: vi.fn(),
    cancelMembership: vi.fn(),
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

      if (table === 'awakes_memberships') {
        return {
          update() {
            return { eq: mocks.cancelMembership };
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

function cancellationRequest(
  secret = 'myasp-cancel-test-secret',
  eventType: string | null = 'paid_contract_cancelled'
) {
  return new NextRequest('https://acti.example.test/api/myasp/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mail: 'member@example.test',
      secret,
      ...(eventType === null ? {} : { event_type: eventType }),
    }),
  });
}

describe('POST /api/myasp/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removePending.mockResolvedValue({ error: null });
    mocks.cancelMembership.mockResolvedValue({ error: null });
    mocks.deactivateProfile.mockResolvedValue({ data: null, error: null });
    mocks.sendDeactivationEmail.mockResolvedValue({ success: true });
  });

  it('does not revoke paid access for an email unsubscribe', async () => {
    configureClient({
      id: 'c88e012a-44bf-4529-962d-068ca69d0bc5',
      email: 'member@example.test',
      display_name: 'Member',
      subscription_status: 'active',
      is_active: true,
    });

    const response = await POST(cancellationRequest(undefined, 'mail_unsubscribed'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      action: 'mail_unsubscribed_access_unchanged',
    });
    expect(mocks.removePending).not.toHaveBeenCalled();
    expect(mocks.cancelMembership).not.toHaveBeenCalled();
    expect(mocks.deactivateProfile).not.toHaveBeenCalled();
    expect(mocks.sendDeactivationEmail).not.toHaveBeenCalled();
  });

  it('refuses an event without explicit paid-contract cancellation evidence', async () => {
    configureClient(null);

    const response = await POST(cancellationRequest(undefined, null));

    expect(response.status).toBe(422);
    expect(mocks.removePending).not.toHaveBeenCalled();
    expect(mocks.cancelMembership).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous reason even when the secret is valid', async () => {
    configureClient(null);
    const response = await POST(new NextRequest('https://acti.example.test/api/myasp/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        mail: 'member@example.test',
        secret: 'myasp-cancel-test-secret',
        reason: '配信解除',
      }),
    }));

    expect(response.status).toBe(422);
    expect(mocks.removePending).not.toHaveBeenCalled();
    expect(mocks.cancelMembership).not.toHaveBeenCalled();
  });

  it('rejects a malformed event type without touching the entitlement', async () => {
    configureClient(null);
    const response = await POST(new NextRequest('https://acti.example.test/api/myasp/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mail: 'member@example.test',
        secret: 'myasp-cancel-test-secret',
        event_type: 123,
      }),
    }));

    expect(response.status).toBe(422);
    expect(mocks.removePending).not.toHaveBeenCalled();
    expect(mocks.cancelMembership).not.toHaveBeenCalled();
  });

  it('accepts an explicitly typed contract cancellation sent as form data', async () => {
    configureClient(null);
    const response = await POST(new NextRequest('https://acti.example.test/api/myasp/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        mail: 'member@example.test',
        secret: 'myasp-cancel-test-secret',
        event_type: 'paid_contract_cancelled',
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.removePending).toHaveBeenCalledWith('email', 'member@example.test');
    expect(mocks.cancelMembership).toHaveBeenCalledWith('email', 'member@example.test');
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
