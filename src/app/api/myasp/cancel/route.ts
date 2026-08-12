import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sendDeactivationEmail } from '@/lib/email';
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
 * MyASP Cancellation / Payment Failure Webhook
 *
 * Called when a user cancels their subscription or payment fails on MyASP.
 * - Finds user by email and deactivates their account
 *
 * MyASP sends POST with form data (application/x-www-form-urlencoded):
 *   - mail: user's email address
 *   - secret: webhook secret for verification
 *   - reason: cancellation reason (optional, depends on MyASP config)
 */
export async function POST(request: NextRequest) {
  try {
    // Parse form data
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
      console.error('MyASP cancellation webhook authentication rejected', {
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

    // A cancellation can arrive before the member creates or links an ACTI
    // account. Remove that pending entitlement first so it cannot later be
    // claimed. Deleting a missing row is intentionally a successful no-op.
    const { error: pendingDeleteError } = await adminClient
      .from('pending_activations')
      .delete()
      .eq('email', email);
    if (pendingDeleteError) {
      console.error('Cancel webhook pending entitlement removal failed:', pendingDeleteError);
      throw pendingDeleteError;
    }

    const { error: membershipCancelError } = await adminClient
      .from('awakes_memberships')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('email', email);
    if (membershipCancelError) {
      console.error('Cancel webhook membership update failed:', membershipCancelError);
      throw membershipCancelError;
    }

    // Find user by email
    const { data: profile, error: findError } = await adminClient
      .from('profiles')
      .select('id, email, display_name, subscription_status, is_active')
      .eq('email', email)
      .single();

    if (findError || !profile) {
      // Also try by myasp_customer_email
      const { data: profileByMyasp } = await adminClient
        .from('profiles')
        .select('id, email, display_name, subscription_status, is_active')
        .eq('myasp_customer_email', email)
        .single();

      if (!profileByMyasp) {
        console.log('Cancel webhook: pending entitlement removed; no linked account found');
        return NextResponse.json({
          success: true,
          action: 'pending_entitlement_revoked',
          message: 'Pending entitlement revoked',
        });
      }

      // Deactivate the user found by myasp_customer_email
      const deactivated = await deactivateUser(adminClient, profileByMyasp);
      return NextResponse.json({
        success: true,
        action: deactivated ? 'deactivated' : 'already_deactivated',
        message: deactivated
          ? 'User subscription deactivated'
          : 'User subscription was already deactivated',
      });
    }

    // Deactivate user
    const deactivated = await deactivateUser(adminClient, profile);

    return NextResponse.json({
      success: true,
      action: deactivated ? 'deactivated' : 'already_deactivated',
      message: deactivated
        ? 'User subscription deactivated'
        : 'User subscription was already deactivated',
    });
  } catch (error) {
    console.error('MyASP cancel webhook error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

async function deactivateUser(
  adminClient: SupabaseClient,
  profile: {
    id: string;
    email: string;
    display_name: string | null;
  }
) {
  // A provider may retry the same cancellation webhook. Make the state change
  // conditional so only the request that actually deactivated the account
  // sends the customer notification.
  const { data: deactivatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({
      subscription_status: 'cancelled',
      is_active: false,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id)
    .or('subscription_status.neq.cancelled,is_active.eq.true')
    .select('id, email, display_name')
    .maybeSingle();

  if (updateError) {
    console.error('Failed to deactivate user:', updateError);
    throw updateError;
  }

  if (!deactivatedProfile) {
    console.log('Subscription was already deactivated');
    return false;
  }

  // Send deactivation notification email
  const emailResult = await sendDeactivationEmail({
    to: deactivatedProfile.email,
    displayName:
      deactivatedProfile.display_name || deactivatedProfile.email.split('@')[0],
  });

  if (!emailResult.success) {
    console.error('Deactivation email failed:', emailResult.error);
  }

  console.log('Subscription deactivated');
  return true;
}
