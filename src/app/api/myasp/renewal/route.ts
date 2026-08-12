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
    const renewalCycle = Number(body.renewal_cycle);
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email (mail) is required' }, { status: 400 });
    }
    if (!externalEventId || externalEventId.length > 200) {
      return NextResponse.json({ error: 'event_id is required' }, { status: 400 });
    }
    if (!Number.isInteger(renewalCycle) || renewalCycle < 1 || renewalCycle > 100) {
      return NextResponse.json({ error: 'renewal_cycle must be a positive integer' }, { status: 400 });
    }

    const source = (body.source || body.scenario_id || 'myasp-renewal')
      .trim()
      .slice(0, 100);
    const occurredAt = readOccurredAt(body.occurred_at || body.paid_at);
    const { data, error } = await createAdminClient().rpc(
      'apply_awakes_membership_event',
      {
        p_email: email,
        p_event_type: 'renewal',
        p_external_event_id: externalEventId,
        p_occurred_at: occurredAt,
        p_renewal_cycle: renewalCycle,
        p_source: source,
      }
    );
    if (error) throw error;

    const result = Array.isArray(data) ? data[0] : data;
    if (result?.status === 'membership_missing') {
      console.error('MyASP renewal could not find an initial membership');
      return NextResponse.json(
        { error: 'Initial membership is missing' },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      action: result?.status === 'duplicate' ? 'already_applied' : 'renewed',
      access_expires_at: result?.access_expires_at || null,
    });
  } catch (error) {
    console.error('MyASP renewal webhook error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
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
