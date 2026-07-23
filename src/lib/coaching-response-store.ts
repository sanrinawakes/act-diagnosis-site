import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatStreamDone } from '@/lib/chat-stream-client';

const PENDING_RESPONSE_PREFIX = '__ACTI_COACHING_RESPONSE_PENDING__:';
const STALE_RESPONSE_MS = 70000;
const RESPONSE_WAIT_MS = 9000;
const RESPONSE_POLL_MS = 300;

type StoredResponseRow = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

export type CoachingResponseState =
  | { status: 'missing' }
  | { status: 'complete'; messageId: string; message: string }
  | {
      status: 'pending' | 'stale';
      messageId: string;
      marker: string;
      createdAt: string;
    }
  | { status: 'conflict'; messageId: string };

export type CoachingResponseClaim =
  | { status: 'owner'; marker: string }
  | Exclude<CoachingResponseState, { status: 'missing' }>;

export async function validateCoachingRequestOwnership(params: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  sessionId: string;
  requestId: string;
}) {
  const [sessionResult, messageResult] = await Promise.all([
    params.supabaseAdmin
      .from('chat_sessions')
      .select('id')
      .eq('id', params.sessionId)
      .eq('user_id', params.userId)
      .maybeSingle(),
    params.supabaseAdmin
      .from('chat_messages')
      .select('id')
      .eq('id', params.requestId)
      .eq('session_id', params.sessionId)
      .eq('role', 'user')
      .maybeSingle(),
  ]);

  if (sessionResult.error) {
    throw new Error(`CHAT_SESSION_LOOKUP_FAILED: ${sessionResult.error.message}`);
  }
  if (messageResult.error) {
    throw new Error(`CHAT_MESSAGE_LOOKUP_FAILED: ${messageResult.error.message}`);
  }

  return Boolean(sessionResult.data && messageResult.data);
}

export async function inspectCoachingResponse(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  assistantMessageId: string;
  now?: number;
}): Promise<CoachingResponseState> {
  const { data, error } = await params.supabaseAdmin
    .from('chat_messages')
    .select('id, role, content, created_at')
    .eq('id', params.assistantMessageId)
    .eq('session_id', params.sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`CHAT_RESPONSE_LOOKUP_FAILED: ${error.message}`);
  }
  if (!data) return { status: 'missing' };

  return classifyStoredCoachingResponse(
    data as StoredResponseRow,
    params.now ?? Date.now()
  );
}

export function classifyStoredCoachingResponse(
  row: StoredResponseRow,
  now = Date.now()
): CoachingResponseState {
  if (row.role === 'assistant' && row.content.trim()) {
    return {
      status: 'complete',
      messageId: row.id,
      message: row.content,
    };
  }

  if (
    row.role === 'system' &&
    row.content.startsWith(PENDING_RESPONSE_PREFIX)
  ) {
    const ageMs = now - new Date(row.created_at).getTime();
    return {
      status: ageMs >= STALE_RESPONSE_MS ? 'stale' : 'pending',
      messageId: row.id,
      marker: row.content,
      createdAt: row.created_at,
    };
  }

  return { status: 'conflict', messageId: row.id };
}

export async function claimCoachingResponse(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  assistantMessageId: string;
  serverRequestId: string;
}): Promise<CoachingResponseClaim> {
  const marker = `${PENDING_RESPONSE_PREFIX}${params.serverRequestId}`;
  const existing = await inspectCoachingResponse(params);

  if (existing.status === 'complete' || existing.status === 'conflict') {
    return existing;
  }
  if (existing.status === 'pending') {
    return existing;
  }

  if (existing.status === 'stale') {
    const { data, error } = await params.supabaseAdmin
      .from('chat_messages')
      .update({
        content: marker,
        created_at: new Date().toISOString(),
      })
      .eq('id', params.assistantMessageId)
      .eq('session_id', params.sessionId)
      .eq('role', 'system')
      .eq('content', existing.marker)
      .select('id')
      .maybeSingle();

    if (error) {
      throw new Error(`CHAT_RESPONSE_TAKEOVER_FAILED: ${error.message}`);
    }
    if (data) return { status: 'owner', marker };
    return excludeMissing(await inspectCoachingResponse(params));
  }

  const { error } = await params.supabaseAdmin.from('chat_messages').insert({
    id: params.assistantMessageId,
    session_id: params.sessionId,
    role: 'system',
    content: marker,
  });

  if (!error) return { status: 'owner', marker };
  if (error.code !== '23505') {
    throw new Error(`CHAT_RESPONSE_CLAIM_FAILED: ${error.message}`);
  }

  return excludeMissing(await inspectCoachingResponse(params));
}

export async function completeCoachingResponse(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  assistantMessageId: string;
  marker: string;
  message: string;
}) {
  const { data, error } = await params.supabaseAdmin
    .from('chat_messages')
    .update({
      role: 'assistant',
      content: params.message,
    })
    .eq('id', params.assistantMessageId)
    .eq('session_id', params.sessionId)
    .eq('role', 'system')
    .eq('content', params.marker)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`CHAT_RESPONSE_SAVE_FAILED: ${error.message}`);
  }
  if (data) return;

  const current = await inspectCoachingResponse(params);
  if (current.status === 'complete' && current.message === params.message) return;
  throw new Error('CHAT_RESPONSE_OWNERSHIP_LOST');
}

export async function waitForCoachingResponse(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  assistantMessageId: string;
  waitMs?: number;
  pollMs?: number;
}): Promise<CoachingResponseState> {
  const deadline = Date.now() + (params.waitMs ?? RESPONSE_WAIT_MS);
  let state = await inspectCoachingResponse(params);

  while (state.status === 'pending' && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, params.pollMs ?? RESPONSE_POLL_MS)
    );
    state = await inspectCoachingResponse(params);
  }

  return state;
}

export function createCachedCoachingStream(params: {
  message: string;
  remaining: number;
  limit: number;
}) {
  const encoder = new TextEncoder();
  const done: ChatStreamDone & {
    type: 'done';
    finishReason: string;
    finalizationStatus: 'complete';
  } = {
    type: 'done',
    message: params.message,
    completionStatus: 'complete',
    finalizationStatus: 'complete',
    finishReason: 'CACHED_REPLAY',
    remaining: params.remaining,
    limit: params.limit,
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({
            type: 'chunk',
            text: params.message,
            verified: true,
          })}\n`
        )
      );
      controller.enqueue(encoder.encode(`${JSON.stringify(done)}\n`));
      controller.close();
    },
  });
}

function excludeMissing(
  state: CoachingResponseState
): Exclude<CoachingResponseState, { status: 'missing' }> {
  if (state.status === 'missing') {
    throw new Error('CHAT_RESPONSE_CLAIM_RACE');
  }
  return state;
}
