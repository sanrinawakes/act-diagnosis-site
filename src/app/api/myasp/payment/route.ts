import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { hasValidWebhookSecret } from '@/lib/webhook-auth';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MYASP_WEBHOOK_SECRET = process.env.MYASP_WEBHOOK_SECRET || '';

function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * MyASP Payment Completion Webhook
 *
 * Called when a user completes payment on MyASP. It records the paid email
 * only. The account holder must later complete the one-time verification code
 * flow before any ACTI account is activated.
 *
 * MyASP sends POST with form data (application/x-www-form-urlencoded):
 *   - mail: user's email address
 *   - name1: user's last name (姓)
 *   - name2: user's first name (名)
 *   - secret: webhook secret for verification
 *   (other fields may be present depending on MyASP configuration)
 */
export async function POST(request: NextRequest) {
  try {
    // Parse form data (MyASP sends as application/x-www-form-urlencoded)
    let body: Record<string, string> = {};

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        body[key] = value.toString();
      });
    } else if (contentType.includes('application/json')) {
      body = await request.json();
    } else {
      // Try to parse as form data anyway
      try {
        const text = await request.text();
        const params = new URLSearchParams(text);
        params.forEach((value, key) => {
          body[key] = value;
        });
      } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
      }
    }

    // Access changes must never accept a webhook when its secret is missing.
    if (!hasValidWebhookSecret(MYASP_WEBHOOK_SECRET, body.secret)) {
      console.error('MyASP payment webhook authentication rejected', {
        configured: Boolean(MYASP_WEBHOOK_SECRET),
      });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Validate required fields
    const email = body.mail?.trim().toLowerCase();
    if (!email) {
      return NextResponse.json(
        { error: 'Email (mail) is required' },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();

    const source = (body.source || body.scenario_id || 'myasp-initial')
      .trim()
      .slice(0, 100);
    const externalEventId = (
      body.event_id || body.order_id || body.item_user_id || `initial:${email}`
    )
      .trim()
      .slice(0, 200);
    const occurredAt = readOccurredAt(body.occurred_at || body.paid_at);
    const { data, error: membershipError } = await adminClient.rpc(
      'apply_awakes_membership_event',
      {
        p_email: email,
        p_event_type: 'initial',
        p_external_event_id: externalEventId,
        p_occurred_at: occurredAt,
        p_renewal_cycle: 0,
        p_source: source,
      }
    );
    if (membershipError) {
      console.error('MyASP payment entitlement save failed:', membershipError);
      throw membershipError;
    }

    console.log('MyASP payment entitlement recorded');

    const result = Array.isArray(data) ? data[0] : data;
    if (result?.status === 'account_not_eligible') {
      console.error('MyASP payment did not reopen a cancelled entitlement');
      return NextResponse.json(
        { error: 'Account is not eligible for automatic activation' },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      action: 'pending_verification',
      event_status: result?.status || 'applied',
      message: 'Payment entitlement recorded',
    });
  } catch (error) {
    console.error('MyASP payment webhook error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function readOccurredAt(raw: string | undefined) {
  if (!raw) return new Date().toISOString();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}
