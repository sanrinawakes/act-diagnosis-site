import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import {
  appendSupportReplyLog,
  buildSupportReplyLogEntry,
} from '@/lib/support-reply-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKFILL_CONFIRMATION = 'backfill-20260616-support-reply-history';

type BackfillEntry = {
  ticketIds: string[];
  sentAt: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  deliveryStatus?: 'sent' | 'failed';
  resendId?: string;
  error?: string;
};

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

function isBackfillEntry(value: unknown): value is BackfillEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Partial<BackfillEntry>;

  return (
    Array.isArray(entry.ticketIds) &&
    entry.ticketIds.every((ticketId) => typeof ticketId === 'string' && ticketId.length > 0) &&
    typeof entry.sentAt === 'string' &&
    typeof entry.senderEmail === 'string' &&
    typeof entry.toEmail === 'string' &&
    typeof entry.subject === 'string' &&
    typeof entry.body === 'string'
  );
}

export async function POST(request: NextRequest) {
  try {
    const backfillSecret = request.headers.get('x-backfill-secret');
    const backfillConfirmation = request.headers.get('x-backfill-confirmation');

    if (
      !process.env.MYASP_WEBHOOK_SECRET ||
      backfillSecret !== process.env.MYASP_WEBHOOK_SECRET
    ) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (backfillConfirmation !== BACKFILL_CONFIRMATION) {
      return NextResponse.json({ error: 'Confirmation header mismatch' }, { status: 400 });
    }

    const payload = await request.json();
    const rawEntries: unknown[] = Array.isArray(payload?.entries) ? payload.entries : [];

    if (!rawEntries.length || rawEntries.length > 100 || !rawEntries.every(isBackfillEntry)) {
      return NextResponse.json({ error: 'Invalid entries payload' }, { status: 400 });
    }

    const entries: BackfillEntry[] = rawEntries;
    const adminClient = createAdminClient();
    const ticketIds = Array.from(new Set(entries.flatMap((entry) => entry.ticketIds)));

    const { data: tickets, error: ticketsError } = await adminClient
      .from('support_tickets')
      .select('id, email, message')
      .in('id', ticketIds);

    if (ticketsError) {
      throw ticketsError;
    }

    const ticketById = new Map((tickets || []).map((ticket) => [ticket.id, ticket]));
    const updated: string[] = [];
    const skippedDuplicate: string[] = [];
    const missing: string[] = [];
    const emailMismatches: Array<{ ticketId: string; ticketEmail: string; entryEmail: string }> = [];

    for (const entry of entries) {
      const replyLogEntry = buildSupportReplyLogEntry({
        sentAt: entry.sentAt,
        senderEmail: entry.senderEmail,
        toEmail: entry.toEmail,
        subject: entry.subject,
        body: entry.body,
        deliveryStatus: entry.deliveryStatus || 'sent',
        resendId: entry.resendId,
        error: entry.error,
      });

      for (const ticketId of entry.ticketIds) {
        const ticket = ticketById.get(ticketId);

        if (!ticket) {
          missing.push(ticketId);
          continue;
        }

        if (ticket.email !== entry.toEmail) {
          emailMismatches.push({
            ticketId,
            ticketEmail: ticket.email,
            entryEmail: entry.toEmail,
          });
          continue;
        }

        const nextMessage = appendSupportReplyLog(ticket.message || '', replyLogEntry);

        if (nextMessage === ticket.message) {
          skippedDuplicate.push(ticketId);
          continue;
        }

        const { error: updateError } = await adminClient
          .from('support_tickets')
          .update({
            message: nextMessage,
            updated_at: entry.sentAt,
          })
          .eq('id', ticketId);

        if (updateError) {
          throw updateError;
        }

        ticket.message = nextMessage;
        updated.push(ticketId);
      }
    }

    return NextResponse.json({
      success: true,
      requestedEntries: entries.length,
      requestedTickets: ticketIds.length,
      updatedCount: updated.length,
      skippedDuplicateCount: skippedDuplicate.length,
      missingCount: missing.length,
      emailMismatchCount: emailMismatches.length,
      updated,
      skippedDuplicate,
      missing,
      emailMismatches,
    });
  } catch (error) {
    console.error('Support reply log backfill failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
