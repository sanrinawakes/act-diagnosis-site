import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import type { LineWebhookEvent } from '@/lib/line';

export function getLineWebhookEventKey(event: LineWebhookEvent) {
  if (event.webhookEventId) return `line:${event.webhookEventId}`;

  const stableFallback = [
    event.type,
    event.timestamp,
    event.source.type,
    event.source.userId || '',
    event.source.groupId || '',
    event.source.roomId || '',
    event.message?.id || '',
    event.replyToken || '',
  ].join(':');
  return `line:fallback:${createHash('sha256').update(stableFallback).digest('hex')}`;
}

export async function claimLineWebhookEvent(params: {
  supabaseAdmin: SupabaseClient;
  event: LineWebhookEvent;
}) {
  const { data, error } = await params.supabaseAdmin.rpc(
    'claim_line_webhook_event',
    {
      p_event_key: getLineWebhookEventKey(params.event),
      p_event_type: params.event.type,
      p_message_id: params.event.message?.id || null,
    }
  );
  if (error) {
    throw new Error(`LINE_WEBHOOK_EVENT_CLAIM_FAILED: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row?.claimed === true;
}

export async function completeLineWebhookEvent(params: {
  supabaseAdmin: SupabaseClient;
  event: LineWebhookEvent;
  status: 'complete' | 'failed';
}) {
  const { error } = await params.supabaseAdmin.rpc(
    'complete_line_webhook_event',
    {
      p_event_key: getLineWebhookEventKey(params.event),
      p_status: params.status,
    }
  );
  if (error) {
    throw new Error(`LINE_WEBHOOK_EVENT_COMPLETE_FAILED: ${error.message}`);
  }
}

export type LineMessageRateReservation = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export async function reserveLineMessageRate(params: {
  supabaseAdmin: SupabaseClient;
  lineUserId: string;
}): Promise<LineMessageRateReservation> {
  const { data, error } = await params.supabaseAdmin.rpc(
    'reserve_line_message_rate',
    {
      p_line_user_id: params.lineUserId,
      p_limit: 12,
      p_window_seconds: 60,
    }
  );
  if (error) {
    throw new Error(`LINE_MESSAGE_RATE_RESERVATION_FAILED: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: row?.allowed === true,
    retryAfterSeconds: Math.max(1, Number(row?.retry_after_seconds) || 1),
  };
}
