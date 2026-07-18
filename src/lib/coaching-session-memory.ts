import type { SupabaseClient } from '@supabase/supabase-js';
import {
  compactCoachingMessages,
  type CoachingChatMessage,
} from '@/lib/coaching-gemini';
import { stripAttachmentMarkdown } from '@/lib/attachments';

const SESSION_MEMORY_PREFIX = 'ACTI_SESSION_MEMORY_V1';
const RECENT_MESSAGE_LIMIT = 24;
const SUMMARY_TRIGGER_MESSAGE_COUNT = 120;
const SUMMARY_REFRESH_DELTA = 60;
const MAX_SUMMARY_SOURCE_MESSAGES = 220;
const SUMMARY_CHAR_LIMIT = 2400;

type MemoryPayload = {
  version: 1;
  generatedAt: string;
  coveredMessageCount: number;
  summary: string;
};

type StoredMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  created_at?: string;
};

export type SessionContextResult = {
  messages: CoachingChatMessage[];
  totalStoredMessages: number | null;
  memoryUsed: boolean;
  memoryRefreshed: boolean;
  memoryCoveredMessages: number | null;
};

export async function buildCoachingSessionContext(params: {
  supabaseAdmin: SupabaseClient;
  sessionId?: string | null;
  userId: string;
  requestMessages: CoachingChatMessage[];
}): Promise<SessionContextResult> {
  const fallback = compactCoachingMessages(params.requestMessages);

  if (!params.sessionId) {
    return {
      messages: fallback,
      totalStoredMessages: null,
      memoryUsed: false,
      memoryRefreshed: false,
      memoryCoveredMessages: null,
    };
  }

  try {
    const { data: session, error: sessionError } = await params.supabaseAdmin
      .from('chat_sessions')
      .select('id')
      .eq('id', params.sessionId)
      .eq('user_id', params.userId)
      .maybeSingle();

    if (sessionError || !session) {
      return {
        messages: fallback,
        totalStoredMessages: null,
        memoryUsed: false,
        memoryRefreshed: false,
        memoryCoveredMessages: null,
      };
    }

    const [countResult, memoryResult, recentResult] = await Promise.all([
      params.supabaseAdmin
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', params.sessionId)
        .in('role', ['user', 'assistant']),
      params.supabaseAdmin
        .from('chat_messages')
        .select('content, created_at')
        .eq('session_id', params.sessionId)
        .eq('role', 'system')
        .like('content', `${SESSION_MEMORY_PREFIX}%`)
        .order('created_at', { ascending: false })
        .limit(1),
      params.supabaseAdmin
        .from('chat_messages')
        .select('role, content, created_at')
        .eq('session_id', params.sessionId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(RECENT_MESSAGE_LIMIT),
    ]);

    if (countResult.error || recentResult.error) {
      return {
        messages: fallback,
        totalStoredMessages: null,
        memoryUsed: false,
        memoryRefreshed: false,
        memoryCoveredMessages: null,
      };
    }

    const totalStoredMessages = countResult.count || 0;
    const recentMessages = toCoachingMessages(
      ((recentResult.data || []) as StoredMessage[]).reverse()
    );
    const latestMemory = parseMemoryPayload(memoryResult.data?.[0]?.content);
    let activeMemory = latestMemory;
    let memoryRefreshed = false;

    const targetCoveredCount = Math.max(0, totalStoredMessages - RECENT_MESSAGE_LIMIT);
    const shouldRefreshMemory =
      totalStoredMessages >= SUMMARY_TRIGGER_MESSAGE_COUNT &&
      targetCoveredCount > 0 &&
      (!latestMemory ||
        targetCoveredCount - latestMemory.coveredMessageCount >= SUMMARY_REFRESH_DELTA);

    if (shouldRefreshMemory) {
      const nextMemory = await createAndStoreMemory({
        supabaseAdmin: params.supabaseAdmin,
        sessionId: params.sessionId,
        previousMemory: latestMemory,
        targetCoveredCount,
      });

      if (nextMemory) {
        activeMemory = nextMemory;
        memoryRefreshed = true;
      }
    }

    const compactRecentMessages = compactCoachingMessages(
      recentMessages.length > 0 ? recentMessages : params.requestMessages
    );

    if (!activeMemory?.summary) {
      return {
        messages: compactRecentMessages.length > 0 ? compactRecentMessages : fallback,
        totalStoredMessages,
        memoryUsed: false,
        memoryRefreshed,
        memoryCoveredMessages: null,
      };
    }

    return {
      messages: [
        {
          role: 'user',
          content: [
            '以下は過去の会話の保存済み要約です。これは新しい相談ではありません。',
            '直近の会話を最優先しつつ、背景として自然に踏まえてください。',
            '',
            activeMemory.summary,
          ].join('\n'),
        },
        {
          role: 'assistant',
          content: '承知しました。保存済み要約を背景として踏まえ、直近の相談に自然に返答します。',
        },
        ...compactRecentMessages,
      ],
      totalStoredMessages,
      memoryUsed: true,
      memoryRefreshed,
      memoryCoveredMessages: activeMemory.coveredMessageCount,
    };
  } catch (error) {
    console.error('Failed to build coaching session context:', error);
    return {
      messages: fallback,
      totalStoredMessages: null,
      memoryUsed: false,
      memoryRefreshed: false,
      memoryCoveredMessages: null,
    };
  }
}

async function createAndStoreMemory(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  previousMemory: MemoryPayload | null;
  targetCoveredCount: number;
}) {
  const startIndex = Math.max(
    0,
    params.targetCoveredCount - MAX_SUMMARY_SOURCE_MESSAGES
  );
  const endIndex = Math.max(startIndex, params.targetCoveredCount - 1);

  const { data, error } = await params.supabaseAdmin
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('session_id', params.sessionId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .range(startIndex, endIndex);

  if (error) {
    console.error('Failed to load messages for session memory:', error);
    return params.previousMemory;
  }

  const sourceMessages = toCoachingMessages((data || []) as StoredMessage[]);
  const summary = buildDeterministicSummary({
    previousSummary: params.previousMemory?.summary || '',
    sourceMessages,
    omittedEarlierMessages: startIndex,
  });

  const memory: MemoryPayload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    coveredMessageCount: params.targetCoveredCount,
    summary,
  };

  const { error: insertError } = await params.supabaseAdmin
    .from('chat_messages')
    .insert({
      session_id: params.sessionId,
      role: 'system',
      content: serializeMemoryPayload(memory),
    });

  if (insertError) {
    console.error('Failed to store coaching session memory:', insertError);
    return params.previousMemory || memory;
  }

  return memory;
}

function buildDeterministicSummary(params: {
  previousSummary: string;
  sourceMessages: CoachingChatMessage[];
  omittedEarlierMessages: number;
}) {
  const userMessages = params.sourceMessages
    .filter((message) => message.role === 'user')
    .map((message) => normalizeText(message.content))
    .filter(Boolean);
  const assistantMessages = params.sourceMessages
    .filter((message) => message.role === 'assistant')
    .map((message) => normalizeText(message.content))
    .filter(Boolean);

  const recentUserTopics = uniqueByValue(userMessages.slice(-18))
    .map((text) => `- ${clipText(text, 120)}`)
    .join('\n');
  const recentAssistantDirections = uniqueByValue(assistantMessages.slice(-8))
    .map((text) => `- ${clipText(text, 140)}`)
    .join('\n');

  const sections = [
    params.previousSummary
      ? `前回までの保存済み要約:\n${clipText(params.previousSummary, 900)}`
      : '',
    params.omittedEarlierMessages > 0
      ? `注記: さらに古い${params.omittedEarlierMessages}件の会話は要約済みまたは安全のため省略。`
      : '',
    recentUserTopics ? `ユーザーが最近話していた主な内容:\n${recentUserTopics}` : '',
    recentAssistantDirections
      ? `直近でコーチが扱っていた方向性:\n${recentAssistantDirections}`
      : '',
  ].filter(Boolean);

  return clipText(sections.join('\n\n'), SUMMARY_CHAR_LIMIT);
}

function serializeMemoryPayload(memory: MemoryPayload) {
  return `${SESSION_MEMORY_PREFIX}\n${JSON.stringify(memory)}`;
}

function parseMemoryPayload(content?: string | null): MemoryPayload | null {
  if (!content?.startsWith(SESSION_MEMORY_PREFIX)) return null;

  try {
    const json = content.slice(SESSION_MEMORY_PREFIX.length).trim();
    const payload = JSON.parse(json) as Partial<MemoryPayload>;
    if (
      payload.version !== 1 ||
      typeof payload.summary !== 'string' ||
      typeof payload.coveredMessageCount !== 'number'
    ) {
      return null;
    }
    return payload as MemoryPayload;
  } catch {
    return null;
  }
}

function toCoachingMessages(messages: StoredMessage[]): CoachingChatMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: String(message.content || ''),
    }))
    .filter((message) => normalizeText(message.content));
}

function normalizeText(text: string) {
  return stripAttachmentMarkdown(text).replace(/\s+/g, ' ').trim();
}

function clipText(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function uniqueByValue(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
