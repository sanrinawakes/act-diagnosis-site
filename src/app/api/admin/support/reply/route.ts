import { createClient as createServerClient } from '@supabase/supabase-js';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import {
  appendSupportReplyLog,
  buildSupportReplyLogEntry,
} from '@/lib/support-reply-log';

export const runtime = 'nodejs';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SUPPORT_FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@silversense.cc';
const SUPPORT_REPLY_TO_EMAIL =
  process.env.SUPPORT_REPLY_TO_EMAIL ||
  process.env.SUPPORT_NOTIFICATION_EMAIL ||
  'silversense.fzco@gmail.com';

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

    if (!RESEND_API_KEY) {
      return NextResponse.json({ error: 'RESEND_API_KEY is not configured' }, { status: 500 });
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
    const { data: ticket, error: ticketError } = await adminClient
      .from('support_tickets')
      .select('id, email, subject, message, status')
      .eq('id', ticketId)
      .single();

    if (ticketError || !ticket) {
      return NextResponse.json({ error: 'チケットが見つかりません' }, { status: 404 });
    }

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `ACTI サポート <${SUPPORT_FROM_EMAIL}>`,
        to: [ticket.email],
        reply_to: SUPPORT_REPLY_TO_EMAIL,
        subject: replySubject,
        text: replyBody,
      }),
    });

    const responseText = await emailResponse.text();
    let responseBody: any = responseText;

    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Keep raw response body.
    }

    const sentAt = new Date().toISOString();
    const deliveryStatus = emailResponse.ok ? 'sent' : 'failed';
    const replyLogEntry = buildSupportReplyLogEntry({
      sentAt,
      senderEmail: adminUser.email,
      toEmail: ticket.email,
      subject: replySubject,
      body: replyBody,
      deliveryStatus,
      resendId: typeof responseBody?.id === 'string' ? responseBody.id : undefined,
      error: emailResponse.ok ? undefined : JSON.stringify(responseBody),
    });

    const nextMessage = appendSupportReplyLog(ticket.message || '', replyLogEntry);
    const nextStatus = emailResponse.ok ? 'in_progress' : ticket.status;
    const { data: updatedTicket, error: updateError } = await adminClient
      .from('support_tickets')
      .update({
        message: nextMessage,
        status: nextStatus,
        updated_at: sentAt,
      })
      .eq('id', ticket.id)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    if (!emailResponse.ok) {
      return NextResponse.json(
        {
          success: false,
          error: '返信メールの送信に失敗しました。履歴には失敗として記録しました。',
          resend: {
            status: emailResponse.status,
            body: responseBody,
          },
          ticket: updatedTicket,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      resend: {
        status: emailResponse.status,
        id: responseBody?.id || null,
      },
      ticket: updatedTicket,
    });
  } catch (error) {
    console.error('POST /api/admin/support/reply error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '返信の送信に失敗しました' },
      { status: 500 }
    );
  }
}
