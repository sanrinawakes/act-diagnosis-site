import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETUP_CONFIRMATION = 'setup-awakes-staff-admin-20260616';
const STAFF_ADMIN_EMAIL = 'awakes2025@gmail.com';
const AUDIT_EMAILS = ['181wyc@gmail.com', STAFF_ADMIN_EMAIL];
const DEFAULT_SUPPORT_NOTIFICATION_EMAIL = 'silversense.fzco@gmail.com';
const DEFAULT_SUPPORT_NOTIFICATION_CC_EMAILS = ['awakes2025@gmail.com'];

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function generateRandomPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

async function findAuthUserIdByEmail(adminClient: ReturnType<typeof createAdminClient>, email: string) {
  let page = 1;

  while (page <= 10) {
    const { data, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage: 1000,
    });

    if (error) {
      throw error;
    }

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) {
      return user.id;
    }

    if (data.users.length < 1000) {
      return null;
    }

    page++;
  }

  return null;
}

function getSupportNotificationEmails(): string[] {
  const primaryEmails = process.env.SUPPORT_NOTIFICATION_EMAIL || DEFAULT_SUPPORT_NOTIFICATION_EMAIL;
  const ccEmails =
    process.env.SUPPORT_NOTIFICATION_CC_EMAILS || DEFAULT_SUPPORT_NOTIFICATION_CC_EMAILS.join(',');

  return Array.from(
    new Set(
      `${primaryEmails},${ccEmails}`
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

async function sendNotificationTest() {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    return {
      skipped: true,
      reason: 'RESEND_API_KEY is not configured',
    };
  }

  const recipients = getSupportNotificationEmails();
  const fromEmail = process.env.FROM_EMAIL || 'noreply@silversense.cc';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: `ACTI サポート <${fromEmail}>`,
      to: recipients,
      subject: '[ACTI サポート] 通知テスト: awakes2025 追加確認',
      text: `ACTIサポート通知の送信先追加テストです。

このメールが届いていれば、サポート通知が以下の宛先へ送信できています。

${recipients.map((recipient) => `- ${recipient}`).join('\n')}

送信日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    }),
  });

  const body = await response.text();
  let parsedBody: unknown = body;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    // Keep raw body.
  }

  return {
    skipped: false,
    recipients,
    ok: response.ok,
    status: response.status,
    response: parsedBody,
  };
}

export async function POST(request: NextRequest) {
  try {
    const setupSecret = request.headers.get('x-setup-secret');
    const setupConfirmation = request.headers.get('x-setup-confirmation');

    if (!process.env.MYASP_WEBHOOK_SECRET || setupSecret !== process.env.MYASP_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (setupConfirmation !== SETUP_CONFIRMATION) {
      return NextResponse.json({ error: 'Confirmation header mismatch' }, { status: 400 });
    }

    const adminClient = createAdminClient();
    const now = new Date().toISOString();
    const email = STAFF_ADMIN_EMAIL;

    const { data: existingProfile, error: existingProfileError } = await adminClient
      .from('profiles')
      .select('id, email, display_name, role, is_active, created_at, updated_at')
      .eq('email', email)
      .maybeSingle();

    if (existingProfileError) {
      throw existingProfileError;
    }

    let authUserId = existingProfile?.id || null;
    let authUserCreated = false;

    if (!authUserId) {
      const foundAuthUserId = await findAuthUserIdByEmail(adminClient, email);
      authUserId = foundAuthUserId;
    }

    if (!authUserId) {
      const { data: createdUser, error: createUserError } =
        await adminClient.auth.admin.createUser({
          email,
          password: generateRandomPassword(),
          email_confirm: true,
          user_metadata: {
            display_name: 'AWAKES Support',
            source: 'staff-bootstrap-20260616',
          },
        });

      if (createUserError) {
        throw createUserError;
      }

      authUserId = createdUser.user?.id || null;
      authUserCreated = !!authUserId;
    }

    if (!authUserId) {
      return NextResponse.json({ error: 'Failed to resolve staff auth user' }, { status: 500 });
    }

    const { data: updatedProfile, error: upsertProfileError } = await adminClient
      .from('profiles')
      .upsert(
        {
          id: authUserId,
          email,
          display_name: existingProfile?.display_name || 'AWAKES Support',
          role: 'admin',
          is_active: true,
          updated_at: now,
        },
        { onConflict: 'id' }
      )
      .select('id, email, display_name, role, is_active, created_at, updated_at')
      .single();

    if (upsertProfileError) {
      throw upsertProfileError;
    }

    const { data: auditProfiles, error: auditError } = await adminClient
      .from('profiles')
      .select('id, email, display_name, role, is_active, updated_at')
      .in('email', AUDIT_EMAILS)
      .order('email', { ascending: true });

    if (auditError) {
      throw auditError;
    }

    const notificationTest = await sendNotificationTest();

    return NextResponse.json({
      success: true,
      staffEmail: email,
      authUserCreated,
      updatedProfile,
      auditProfiles,
      notificationTest,
    });
  } catch (error) {
    console.error('Staff bootstrap failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
