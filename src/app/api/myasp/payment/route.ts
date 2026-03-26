import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendWelcomeEmail } from '@/lib/email';
import crypto from 'crypto';

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
 * Generate a random password (12 characters, alphanumeric + symbols)
 */
function generatePassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let password = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

/**
 * MyASP Payment Completion Webhook
 *
 * Called when a user completes payment on MyASP.
 * - If user already exists (by email): activates their account
 * - If user doesn't exist: creates a new account and sends welcome email
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

    console.log('MyASP payment webhook received:', {
      email: body.mail,
      name1: body.name1,
      name2: body.name2,
      hasSecret: !!body.secret,
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

    const name1 = body.name1?.trim() || '';
    const name2 = body.name2?.trim() || '';
    const displayName = name2 ? `${name1} ${name2}` : name1 || email.split('@')[0];

    const adminClient = createAdminClient();

    // Check if a user with this email already exists
    const { data: existingProfile } = await adminClient
      .from('profiles')
      .select('id, email, subscription_status, is_active')
      .eq('email', email)
      .single();

    if (existingProfile) {
      // User already exists → activate their subscription
      const { error: updateError } = await adminClient
        .from('profiles')
        .update({
          subscription_status: 'active',
          is_active: true,
          myasp_customer_email: email,
          subscribed_at: new Date().toISOString(),
          cancelled_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingProfile.id);

      if (updateError) {
        console.error('Failed to update existing user:', updateError);
        throw updateError;
      }

      console.log(`Activated existing user: ${email}`);
      return NextResponse.json({
        success: true,
        action: 'activated',
        email,
        message: 'Existing user subscription activated',
      });
    }

    // User doesn't exist → create new account
    const password = generatePassword();

    // Create auth user via Supabase Admin API
    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm email
      user_metadata: {
        display_name: displayName,
        source: 'myasp',
      },
    });

    if (createError) {
      console.error('Failed to create auth user:', createError);
      throw createError;
    }

    if (!newUser.user) {
      throw new Error('User creation returned no user');
    }

    // Update the auto-created profile with MyASP fields
    // (profile is auto-created by the handle_new_user trigger)
    // Wait a moment for the trigger to fire
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { error: profileError } = await adminClient
      .from('profiles')
      .update({
        display_name: displayName,
        subscription_status: 'active',
        is_active: true,
        myasp_customer_email: email,
        subscribed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', newUser.user.id);

    if (profileError) {
      console.error('Failed to update new user profile:', profileError);
      // Don't throw - the user was created, just the profile update failed
    }

    // Send welcome email with login credentials
    const emailResult = await sendWelcomeEmail({
      to: email,
      displayName,
      password,
    });

    if (!emailResult.success) {
      console.error('Welcome email failed (user was still created):', emailResult.error);
    }

    console.log(`Created new user: ${email}, email sent: ${emailResult.success}`);

    return NextResponse.json({
      success: true,
      action: 'created',
      email,
      emailSent: emailResult.success,
      message: 'New user created and welcome email sent',
    });
  } catch (error) {
    console.error('MyASP payment webhook error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
