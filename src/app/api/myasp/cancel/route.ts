import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendDeactivationEmail } from '@/lib/email';

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

    console.log('MyASP cancel webhook received:', {
      email: body.mail,
      reason: body.reason,
    });

    // Verify webhook secret if configured
    if (MYASP_WEBHOOK_SECRET && body.secret !== MYASP_WEBHOOK_SECRET) {
      console.error('MyASP webhook secret mismatch');
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
        console.log(`Cancel webhook: no user found with email ${email}`);
        return NextResponse.json({
          success: false,
          message: 'User not found',
          email,
        });
      }

      // Deactivate the user found by myasp_customer_email
      await deactivateUser(adminClient, profileByMyasp);
      return NextResponse.json({
        success: true,
        action: 'deactivated',
        email,
        message: 'User subscription deactivated',
      });
    }

    // Deactivate user
    await deactivateUser(adminClient, profile);

    return NextResponse.json({
      success: true,
      action: 'deactivated',
      email,
      message: 'User subscription deactivated',
    });
  } catch (error) {
    console.error('MyASP cancel webhook error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

async function deactivateUser(
  adminClient: any,
  profile: { id: string; email: string; display_name: string | null }
) {
  const { error: updateError } = await adminClient
    .from('profiles')
    .update({
      subscription_status: 'cancelled',
      is_active: false,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id);

  if (updateError) {
    console.error('Failed to deactivate user:', updateError);
    throw updateError;
  }

  // Send deactivation notification email
  const emailResult = await sendDeactivationEmail({
    to: profile.email,
    displayName: profile.display_name || profile.email.split('@')[0],
  });

  if (!emailResult.success) {
    console.error('Deactivation email failed:', emailResult.error);
  }

  console.log(`Deactivated user: ${profile.email}`);
}
