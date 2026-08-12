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
      console.error('MyASP payment-state webhook authentication rejected', {
        configured: Boolean(myaspWebhookSecret),
      });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const email = body.mail?.trim().toLowerCase();
    const state = body.state?.trim();
    const externalEventId = body.event_id?.trim();
    const source = (body.source || body.scenario_id || '').trim();

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email (mail) is required' }, { status: 400 });
    }
    if (state !== 'payment_failed' && state !== 'payment_restored') {
      return NextResponse.json({ error: 'Valid payment state is required' }, { status: 400 });
    }
    if (!externalEventId || externalEventId.length > 200) {
      return NextResponse.json({ error: 'event_id is required' }, { status: 400 });
    }
    if (!source || source.length > 100) {
      return NextResponse.json({ error: 'source is required' }, { status: 400 });
    }

    const occurredAt = readOccurredAt(body.occurred_at);
    if (!occurredAt) {
      return NextResponse.json({ error: 'Valid occurred_at is required' }, { status: 400 });
    }
    const { data, error } = await createAdminClient().rpc(
      'apply_awakes_payment_state_event',
      {
        p_email: email,
        p_state: state,
        p_external_event_id: externalEventId,
        p_occurred_at: occurredAt,
        p_source: source,
      }
    );
    if (error) throw error;

    const result = Array.isArray(data) ? data[0] : data;
    const resultStatus = result?.status || 'applied';
    if (resultStatus === 'membership_missing') {
      console.error('MyASP payment restore could not find an AWAKES membership');
      return NextResponse.json({ error: 'AWAKES membership is missing' }, { status: 409 });
    }
    if (resultStatus === 'account_not_eligible') {
      return NextResponse.json({ error: 'Account is not eligible for restoration' }, { status: 409 });
    }
    if (resultStatus === 'term_expired') {
      return NextResponse.json({ error: 'AWAKES membership term has expired' }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      action:
        resultStatus === 'duplicate'
          ? 'already_applied'
          : resultStatus === 'stale'
            ? 'ignored_stale_event'
            : state === 'payment_failed'
              ? 'access_suspended'
              : 'access_restored',
      membership_status: result?.membership_status || null,
      profiles_changed: result?.profiles_changed || 0,
      pending_changed: result?.pending_changed || 0,
    });
  } catch (error) {
    console.error('MyASP payment-state webhook error:', error);
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
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
