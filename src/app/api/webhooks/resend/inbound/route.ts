import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { processSupportInboundEmail } from '@/lib/support-inbound-processor';
import { createSupportInboundDependencies } from '@/lib/server/support-inbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';
const SUPPORT_INBOUND_DOMAIN = process.env.SUPPORT_INBOUND_DOMAIN || '';
const SUPPORT_INBOUND_SECRET = process.env.SUPPORT_INBOUND_SECRET || '';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export async function POST(request: NextRequest) {
  if (
    !RESEND_API_KEY ||
    !RESEND_WEBHOOK_SECRET ||
    !SUPPORT_INBOUND_DOMAIN ||
    !SUPPORT_INBOUND_SECRET ||
    !supabaseUrl ||
    !supabaseServiceRoleKey
  ) {
    console.error('Support inbound webhook is not fully configured');
    return NextResponse.json(
      { error: 'Webhook is not configured' },
      { status: 503 }
    );
  }

  const webhookId = request.headers.get('svix-id') || '';
  const webhookTimestamp = request.headers.get('svix-timestamp') || '';
  const webhookSignature = request.headers.get('svix-signature') || '';
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return NextResponse.json(
      { error: 'Missing webhook signature headers' },
      { status: 400 }
    );
  }

  const rawPayload = await request.text();
  const resend = new Resend(RESEND_API_KEY);
  let event;
  try {
    event = resend.webhooks.verify({
      payload: rawPayload,
      headers: {
        id: webhookId,
        timestamp: webhookTimestamp,
        signature: webhookSignature,
      },
      webhookSecret: RESEND_WEBHOOK_SECRET,
    });
  } catch {
    console.warn('Rejected invalid Resend webhook signature');
    return NextResponse.json(
      { error: 'Invalid webhook signature' },
      { status: 400 }
    );
  }

  if (event.type !== 'email.received') {
    return NextResponse.json({ received: true, ignored: true });
  }

  try {
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const result = await processSupportInboundEmail(
      {
        emailId: event.data.email_id,
        webhookId,
        recipientAddresses: [
          ...(event.data.received_for || []),
          ...(event.data.to || []),
        ],
        domain: SUPPORT_INBOUND_DOMAIN,
        secret: SUPPORT_INBOUND_SECRET,
      },
      createSupportInboundDependencies({
        adminClient,
        resend,
      })
    );

    if (result.outcome === 'ignored') {
      console.warn('Ignored support inbound email', {
        emailId: event.data.email_id,
        reason: result.reason,
      });
    } else {
      console.log('Processed support inbound email', {
        emailId: event.data.email_id,
        outcome: result.outcome,
        ticketId: result.ticketId,
      });
    }

    return NextResponse.json({
      received: true,
      outcome: result.outcome,
    });
  } catch (error) {
    console.error('Support inbound webhook processing failed', {
      emailId: event.data.email_id,
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return NextResponse.json(
      { error: 'Inbound email processing failed' },
      { status: 503 }
    );
  }
}
