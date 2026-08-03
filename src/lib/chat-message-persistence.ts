import type { SupabaseClient } from '@supabase/supabase-js';

type PersistChatMessageParams = {
  supabase: SupabaseClient;
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
};

type StoredChatMessageRow = {
  id: string;
  role: string;
  content: string;
};

export async function persistChatMessageRecord(
  params: PersistChatMessageParams
) {
  const insertResult = await params.supabase.from('chat_messages').insert({
    id: params.id,
    session_id: params.sessionId,
    role: params.role,
    content: params.content,
  });

  if (!insertResult.error) return;
  if (insertResult.error.code !== '23505') {
    throw insertResult.error;
  }

  if (params.role !== 'assistant') {
    return;
  }

  const { data: replacedRow, error: replaceError } = await params.supabase
    .from('chat_messages')
    .update({
      role: 'assistant',
      content: params.content,
    })
    .eq('id', params.id)
    .eq('session_id', params.sessionId)
    .eq('role', 'system')
    .select('id')
    .maybeSingle();

  if (replaceError) {
    throw replaceError;
  }
  if (replacedRow) {
    return;
  }

  const { data: currentRow, error: currentError } = await params.supabase
    .from('chat_messages')
    .select('id, role, content')
    .eq('id', params.id)
    .eq('session_id', params.sessionId)
    .maybeSingle<StoredChatMessageRow>();

  if (currentError) {
    throw currentError;
  }
  if (
    currentRow?.role === 'assistant' &&
    currentRow.content === params.content
  ) {
    return;
  }

  throw new Error('CHAT_MESSAGE_PERSIST_CONFLICT');
}
