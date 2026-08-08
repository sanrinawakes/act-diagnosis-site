import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  claimLineWebhookEvent,
  completeLineWebhookEvent,
  getLineWebhookEventKey,
} from '../src/lib/line-webhook-events';

const event = {
  webhookEventId: '01JLINEEVENT',
  type: 'message',
  replyToken: 'reply-token',
  source: { type: 'user', userId: 'line-user-id' },
  timestamp: 1_723_000_000_000,
  mode: 'active',
  message: { type: 'text', id: 'message-id', text: 'sensitive customer text' },
} as const;

describe('LINE webhook event idempotency', () => {
  it('uses LINE event ids and never includes customer text in its key', () => {
    expect(getLineWebhookEventKey(event)).toBe('line:01JLINEEVENT');
    const fallback = getLineWebhookEventKey({ ...event, webhookEventId: undefined });
    expect(fallback).toMatch(/^line:fallback:[a-f0-9]{64}$/);
    expect(fallback).not.toContain(event.message.text);
  });

  it('asks the database to atomically claim an event before processing it', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ claimed: true }], error: null });
    await expect(
      claimLineWebhookEvent({ supabaseAdmin: client(rpc), event })
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('claim_line_webhook_event', {
      p_event_key: 'line:01JLINEEVENT',
      p_event_type: 'message',
      p_message_id: 'message-id',
    });
  });

  it('does not process an event when the database says a previous worker owns it', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ claimed: false }], error: null });
    await expect(
      claimLineWebhookEvent({ supabaseAdmin: client(rpc), event })
    ).resolves.toBe(false);
  });

  it('records a final outcome without storing consultation content', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await completeLineWebhookEvent({
      supabaseAdmin: client(rpc),
      event,
      status: 'complete',
    });
    expect(rpc).toHaveBeenCalledWith('complete_line_webhook_event', {
      p_event_key: 'line:01JLINEEVENT',
      p_status: 'complete',
    });
  });
});

function client(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient;
}
