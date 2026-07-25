import { createClient as createServerClient } from '@supabase/supabase-js';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import {
  buildSupportEmailIdempotencyKey,
  deliverSupportReply,
} from '@/lib/server/support-email';

export const runtime = 'nodejs';

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createServerClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function verifyAdminRole(): Promise<{ id: string; email: string } | null> {
  try {
    const cookieStore = await cookies();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return null;
    }

    const ssrClient = createSSRClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignore server component errors.
          }
        },
      },
    });

    const {
      data: { user },
    } = await ssrClient.auth.getUser();

    if (!user) {
      return null;
    }

    const { data: profile, error } = await ssrClient
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .single();

    if (error || !profile || profile.role !== 'admin') {
      return null;
    }

    return {
      id: user.id,
      email: profile.email || user.email || 'unknown-admin',
    };
  } catch (error) {
    console.error('Admin verification failed:', error);
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const adminUser = await verifyAdminRole();
    if (!adminUser) {
      return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await request.json();
    const ticketId = typeof body.ticket_id === 'string' ? body.ticket_id : '';
    const replySubject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const replyBody = typeof body.message === 'string' ? body.message.trim() : '';

    if (!ticketId || !replySubject || !replyBody) {
      return NextResponse.json(
        { error: 'ticket_id, subject, message が必要です' },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();
    const requestedIdempotencyKey =
      typeof body.idempotency_key === 'string'
        ? body.idempotency_key.trim()
        : '';
    const idempotencyKey = /^[A-Za-z0-9_-]{8,180}$/.test(
      requestedIdempotencyKey
    )
      ? requestedIdempotencyKey
      : buildSupportEmailIdempotencyKey({
          ticketId,
          purpose: 'manual-reply',
          content: `${replySubject}\n${replyBody}`,
        });
    const result = await deliverSupportReply({
      adminClient,
      ticketId,
      subject: replySubject,
      message: replyBody,
      senderLabel: adminUser.email,
      idempotencyKey,
      statusOnSuccess: 'in_progress',
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: '返信メールの送信に失敗しました。履歴には失敗として記録しました。',
          resend: result.resend,
          ticket: result.ticket,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      already_sent: result.alreadySent,
      resend: result.resend,
      ticket: result.ticket,
    });
  } catch (error) {
    console.error('POST /api/admin/support/reply error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '返信の送信に失敗しました' },
      { status: 500 }
    );
  }
}
