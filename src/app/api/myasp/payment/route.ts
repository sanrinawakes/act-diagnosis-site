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

    // Keep the entitlement pending. Do not overwrite an already-consumed
    // record when MyASP retries the same payment webhook.
    const { error: pendingError } = await adminClient
      .from('pending_activations')
      .upsert(
        { email, source: 'myasp' },
        { onConflict: 'email' }
      );
    if (pendingError) {
      console.error('MyASP payment entitlement save failed:', pendingError);
      throw pendingError;
    }

    console.log('MyASP payment entitlement recorded');

    return NextResponse.json({
      success: true,
      action: 'pending_verification',
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
