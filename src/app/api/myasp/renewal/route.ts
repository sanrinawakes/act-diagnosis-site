import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { hasValidWebhookSecret } from '@/lib/webhook-auth';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const myaspWebhookSecret = process.env.MYASP_WEBHOOK_SECRET || '';

function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

type MembershipEventResult = {
  status?: string | null;
  access_expires_at?: string | null;
};

export async function POST(request: NextRequest) {
  try {
    const body = await readWebhookBody(request);
    if (!hasValidWebhookSecret(myaspWebhookSecret, body.secret)) {
      console.error('MyASP renewal webhook authentication rejected', {
        configured: Boolean(myaspWebhookSecret),
      });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const email = body.mail?.trim().toLowerCase();
    const externalEventId = (
      body.event_id || body.order_id || body.item_user_id || ''
    ).trim();
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email (mail) is required' }, { status: 400 });
    }
    if (!externalEventId || externalEventId.length > 200) {
      return NextResponse.json({ error: 'event_id is required' }, { status: 400 });
    }
    const source = (body.source || body.scenario_id || 'myasp-renewal')
      .trim()
      .slice(0, 100);
    const occurredAt = readOccurredAt(body.occurred_at || body.paid_at);
    const adminClient = createAdminClient();
    let result = await applyMembershipEvent(adminClient, {
      p_email: email,
      p_event_type: 'renewal',
      p_external_event_id: externalEventId,
      p_occurred_at: occurredAt,
      // The database derives the next cycle atomically from each unique paid
      // event. MyASP must not carry a manually updated year counter.
      p_renewal_cycle: 0,
      p_source: source,
    });
    let bootstrappedFromRenewal = false;

    if (result?.status === 'membership_missing') {
      console.warn(
        'MyASP renewal bootstrapping missing initial membership via paid renewal'
      );
      result = await applyMembershipEvent(adminClient, {
        p_email: email,
        p_event_type: 'initial',
        p_external_event_id: externalEventId,
        p_occurred_at: occurredAt,
        p_renewal_cycle: 0,
        p_source: source,
      });
      bootstrappedFromRenewal = true;
    }

    if (result?.status === 'membership_missing') {
      console.error('MyASP renewal could not create a missing membership');
      return NextResponse.json(
        { error: 'Initial membership is missing' },
        { status: 409 }
      );
    }

    if (result?.status === 'account_not_eligible') {
      console.error('MyASP renewal did not reopen a cancelled entitlement');
      return NextResponse.json(
        { error: 'Account is not eligible for automatic activation' },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      action: result?.status === 'duplicate' ? 'already_applied' : 'renewed',
      access_expires_at: result?.access_expires_at || null,
      bootstrapped_from_renewal: bootstrappedFromRenewal,
    });
  } catch (error) {
    console.error('MyASP renewal webhook error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function applyMembershipEvent(
  adminClient: ReturnType<typeof createAdminClient>,
  payload: {
    p_email: string;
    p_event_type: 'initial' | 'renewal';
    p_external_event_id: string;
    p_occurred_at: string;
    p_renewal_cycle: number;
    p_source: string;
  }
) {
  const { data, error } = await adminClient.rpc(
    'apply_awakes_membership_event',
    payload
  );
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as MembershipEventResult;
}

async function readWebhookBody(request: NextRequest) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return (await request.json()) as Record<string, string>;
  }

  const body: Record<string, string> = {};
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
    formData.forEach((value, key) => {
      body[key] = value.toString();
    });
    return body;
  }

  const params = new URLSearchParams(await request.text());
  params.forEach((value, key) => {
    body[key] = value;
  });
  return body;
}

function readOccurredAt(raw: string | undefined) {
  if (!raw) return new Date().toISOString();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}
