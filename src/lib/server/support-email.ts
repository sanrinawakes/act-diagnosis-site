import 'server-only';

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  appendSupportReplyLog,
  buildSupportReplyLogEntry,
  hasSupportReplyIdempotencyKey,
} from '@/lib/support-reply-log';
import { buildSupportInboundReplyAddress } from '@/lib/support-inbound';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SUPPORT_FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@silversense.cc';
const SUPPORT_REPLY_TO_EMAIL =
  process.env.SUPPORT_REPLY_TO_EMAIL ||
  process.env.SUPPORT_NOTIFICATION_EMAIL ||
  'silversense.fzco@gmail.com';
const SUPPORT_INBOUND_DOMAIN = process.env.SUPPORT_INBOUND_DOMAIN || '';
const SUPPORT_INBOUND_SECRET = process.env.SUPPORT_INBOUND_SECRET || '';
const RESEND_TIMEOUT_MS = 10_000;

type SupportTicketRecord = {
  id: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  updated_at: string;
};

export function buildSupportEmailIdempotencyKey(params: {
  ticketId: string;
  purpose: string;
  content?: string;
}) {
  const purpose = params.purpose.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50);
  const digest = createHash('sha256')
    .update(params.content || params.purpose)
    .digest('hex')
    .slice(0, 24);

  return `${purpose}-${params.ticketId}-${digest}`;
}

export async function deliverSupportReply(params: {
  adminClient: SupabaseClient;
  ticketId: string;
  subject: string;
  message: string;
  senderLabel: string;
  idempotencyKey: string;
  statusOnSuccess: 'open' | 'in_progress' | 'resolved';
  automationRunId?: string;
  evidence?: string;
}) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const { data: ticket, error: ticketError } = await params.adminClient
    .from('support_tickets')
    .select('id, email, subject, message, status, updated_at')
    .eq('id', params.ticketId)
    .single<SupportTicketRecord>();

  if (ticketError || !ticket) {
    throw new Error('チケットが見つかりません');
  }

  if (hasSupportReplyIdempotencyKey(ticket.message || '', params.idempotencyKey)) {
    return {
      success: true,
      alreadySent: true,
      ticket,
      resend: { status: 200, id: null },
    };
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), RESEND_TIMEOUT_MS);
  let emailResponse: Response;

  try {
    emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Idempotency-Key': params.idempotencyKey,
      },
      body: JSON.stringify({
        from: `ACTI サポート <${SUPPORT_FROM_EMAIL}>`,
        to: [ticket.email],
        reply_to: getSupportReplyToAddress(ticket.id),
        subject: params.subject,
        text: params.message,
      }),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText = await emailResponse.text();
  let responseBody: Record<string, unknown> | string = responseText;
  try {
    responseBody = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    // Keep non-JSON provider responses for the audit log.
  }

  const sentAt = new Date().toISOString();
  const resendId =
    typeof responseBody === 'object' && typeof responseBody.id === 'string'
      ? responseBody.id
      : undefined;
  const deliveryStatus = emailResponse.ok ? 'sent' : 'failed';
  const replyLogEntry = buildSupportReplyLogEntry({
    sentAt,
    senderEmail: params.senderLabel,
    toEmail: ticket.email,
    subject: params.subject,
    body: params.message,
    deliveryStatus,
    resendId,
    idempotencyKey: params.idempotencyKey,
    automationRunId: params.automationRunId,
    evidence: params.evidence,
    error: emailResponse.ok
      ? undefined
      : JSON.stringify(responseBody).slice(0, 1000),
  });
  const nextMessage = appendSupportReplyLog(ticket.message || '', replyLogEntry);

  const { data: updatedTicket, error: updateError } = await params.adminClient
    .from('support_tickets')
    .update({
      message: nextMessage,
      status: emailResponse.ok ? params.statusOnSuccess : ticket.status,
      updated_at: sentAt,
    })
    .eq('id', ticket.id)
    .eq('updated_at', ticket.updated_at)
    .select()
    .maybeSingle();

  if (updateError) {
    throw updateError;
  }
  if (!updatedTicket) {
    throw new Error(
      'チケットが同時に更新されました。同じ重複防止キーで再試行してください。'
    );
  }

  return {
    success: emailResponse.ok,
    alreadySent: false,
    ticket: updatedTicket,
    resend: {
      status: emailResponse.status,
      id: resendId || null,
      body: emailResponse.ok ? undefined : responseBody,
    },
  };
}

export function getSupportReplyToAddress(ticketId: string) {
  if (SUPPORT_INBOUND_DOMAIN && SUPPORT_INBOUND_SECRET) {
    return buildSupportInboundReplyAddress({
      ticketId,
      domain: SUPPORT_INBOUND_DOMAIN,
      secret: SUPPORT_INBOUND_SECRET,
    });
  }

  return SUPPORT_REPLY_TO_EMAIL;
}
