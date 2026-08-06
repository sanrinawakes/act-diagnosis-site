import type { SupabaseClient } from '@supabase/supabase-js';
import {
  compactCoachingMessages,
  type CoachingChatMessage,
} from '@/lib/coaching-gemini';
import { stripAttachmentMarkdown } from '@/lib/attachments';

export const COACHING_SESSION_MEMORY_PREFIX = 'ACTI_SESSION_MEMORY_V1';
export const COACHING_RECENT_MESSAGE_LIMIT = 24;
const MEMORY_DELTA_OVERLAP = 8;
const CONTEXT_MESSAGE_LIMIT =
  COACHING_RECENT_MESSAGE_LIMIT + MEMORY_DELTA_OVERLAP;
const STALE_CONTEXT_RESET_MS = 18 * 60 * 60 * 1000;
const SUMMARY_TRIGGER_MESSAGE_COUNT = COACHING_RECENT_MESSAGE_LIMIT + 1;
const SUMMARY_REFRESH_DELTA = 1;
const MAX_SUMMARY_SOURCE_MESSAGES = 220;
const SUMMARY_CHAR_LIMIT = 2400;
const SESSION_MEMORY_REFRESH_TIMEOUT_MS = 10000;
const CONTINUATION_REQUEST_PATTERN =
  /続き|その後|さっき|先ほど|前回|前の|この件|この話|それで|それについて|同じ件|引き続き/;

const CONTEXT_DOMAIN_PATTERNS = {
  work: /仕事|職場|会社|業務|上司|同僚|契約|始業|部長|統括|遅参|書面/,
  money: /お金|金銭|家計|収支|借金|貯金|返済|カード|年会費|残高|支払い|家賃/,
  health: /健康|病院|医師|薬|検査|腎臓|通院|体調|精神科/,
  family: /夫|妻|家族|親|子ども|子供|パートナー|相手|家庭/,
  future: /5年後|将来|未来|目標|なりたい/,
} as const;

type MemoryPayload = {
  version: 1;
  generatedAt: string;
  coveredMessageCount: number;
  summary: string;
};

type StoredMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  created_at?: string;
};

export type SessionContextResult = {
  messages: CoachingChatMessage[];
  totalStoredMessages: number | null;
  memoryUsed: boolean;
  memoryRefreshed: boolean;
  memoryRefreshScheduled: boolean;
  memoryCoveredMessages: number | null;
};

export async function buildCoachingSessionContext(params: {
  supabaseAdmin: SupabaseClient;
  sessionId?: string | null;
  userId: string;
  requestMessages: CoachingChatMessage[];
  scheduleMemoryRefresh?: (task: () => Promise<void>) => void;
}): Promise<SessionContextResult> {
  const fallback = compactCoachingMessages(params.requestMessages);

  if (!params.sessionId) {
    return {
      messages: fallback,
      totalStoredMessages: null,
      memoryUsed: false,
      memoryRefreshed: false,
      memoryRefreshScheduled: false,
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
        memoryRefreshScheduled: false,
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
        .select('id, content, created_at')
        .eq('session_id', params.sessionId)
        .eq('role', 'system')
        .like('content', `${COACHING_SESSION_MEMORY_PREFIX}%`)
        .order('created_at', { ascending: false })
        .limit(1),
      params.supabaseAdmin
        .from('chat_messages')
        .select('role, content, created_at')
        .eq('session_id', params.sessionId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(CONTEXT_MESSAGE_LIMIT),
    ]);

    if (countResult.error || recentResult.error) {
      return {
        messages: fallback,
        totalStoredMessages: null,
        memoryUsed: false,
        memoryRefreshed: false,
        memoryRefreshScheduled: false,
        memoryCoveredMessages: null,
      };
    }

    const totalStoredMessages = countResult.count || 0;
    const loadedMessages = toCoachingMessages(
      ((recentResult.data || []) as StoredMessage[]).reverse()
    );
    const recentMessages = loadedMessages.slice(
      -COACHING_RECENT_MESSAGE_LIMIT
    );
    const latestStoredMessageCreatedAt =
      ((recentResult.data || []) as StoredMessage[])[0]?.created_at || null;
    const latestMemory = parseMemoryPayload(memoryResult.data?.[0]?.content);
    let activeMemory = latestMemory;
    let memoryRefreshed = false;
    let memoryRefreshScheduled = false;

    const targetCoveredCount = Math.max(
      0,
      totalStoredMessages - COACHING_RECENT_MESSAGE_LIMIT
    );
    const shouldRefreshMemory = shouldRefreshSessionMemory(
      totalStoredMessages,
      latestMemory?.coveredMessageCount ?? null
    );

    if (shouldRefreshMemory) {
      const previousCoveredCount =
        latestMemory?.coveredMessageCount ?? 0;
      const loadedStartIndex = Math.max(
        0,
        totalStoredMessages - loadedMessages.length
      );
      const deltaStartIndex = previousCoveredCount - loadedStartIndex;
      const deltaEndIndex = targetCoveredCount - loadedStartIndex;
      const hasCompleteDelta =
        deltaStartIndex >= 0 &&
        deltaEndIndex > deltaStartIndex &&
        deltaEndIndex <= loadedMessages.length;
      let preparedMemory: MemoryPayload | null = null;

      if (hasCompleteDelta) {
        preparedMemory = buildMemoryPayload({
          previousMemory: latestMemory,
          sourceMessages: loadedMessages.slice(
            deltaStartIndex,
            deltaEndIndex
          ),
          omittedEarlierMessages: previousCoveredCount,
          targetCoveredCount,
        });
      } else {
        preparedMemory = await createMemory({
          supabaseAdmin: params.supabaseAdmin,
          sessionId: params.sessionId,
          previousMemory: latestMemory,
          targetCoveredCount,
        });
      }

      if (preparedMemory) {
        activeMemory = preparedMemory;
      }

      const refreshMemory = async () => {
        try {
          if ((!latestMemory || !hasCompleteDelta) && preparedMemory) {
            await storeMemory({
              supabaseAdmin: params.supabaseAdmin,
              sessionId: params.sessionId!,
              memoryRowId: memoryResult.data?.[0]?.id || null,
              memory: preparedMemory,
            });
            return;
          }

          await createAndStoreMemory({
            supabaseAdmin: params.supabaseAdmin,
            sessionId: params.sessionId!,
            memoryRowId: memoryResult.data?.[0]?.id || null,
            previousMemory: latestMemory,
            targetCoveredCount,
          });
        } catch (error) {
          console.error('Failed to refresh coaching session memory:', error);
        }
      };

      if (params.scheduleMemoryRefresh) {
        try {
          params.scheduleMemoryRefresh(refreshMemory);
          memoryRefreshScheduled = true;
        } catch (error) {
          console.error('Failed to schedule coaching session memory:', error);
        }
      } else {
        await refreshMemory();
        memoryRefreshed = Boolean(preparedMemory);
      }
    }

    const compactRecentMessages = mergeRecentCoachingMessages(
      recentMessages,
      params.requestMessages
    );
    const shouldPreferRequestOnly = shouldPreferRequestOnlyContext({
      latestStoredMessageCreatedAt,
      storedMessages: recentMessages,
      requestMessages: params.requestMessages,
    });

    if (shouldPreferRequestOnly) {
      return {
        messages: fallback,
        totalStoredMessages,
        memoryUsed: false,
        memoryRefreshed,
        memoryRefreshScheduled,
        memoryCoveredMessages: null,
      };
    }

    if (!activeMemory?.summary) {
      return {
        messages: compactRecentMessages.length > 0 ? compactRecentMessages : fallback,
        totalStoredMessages,
        memoryUsed: false,
        memoryRefreshed,
        memoryRefreshScheduled,
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
      memoryRefreshScheduled,
      memoryCoveredMessages: activeMemory.coveredMessageCount,
    };
  } catch (error) {
    console.error('Failed to build coaching session context:', error);
    return {
      messages: fallback,
      totalStoredMessages: null,
      memoryUsed: false,
      memoryRefreshed: false,
      memoryRefreshScheduled: false,
      memoryCoveredMessages: null,
    };
  }
}

export function shouldRefreshSessionMemory(
  totalStoredMessages: number,
  coveredMessageCount: number | null
) {
  const targetCoveredCount = Math.max(
    0,
    totalStoredMessages - COACHING_RECENT_MESSAGE_LIMIT
  );

  return (
    totalStoredMessages >= SUMMARY_TRIGGER_MESSAGE_COUNT &&
    targetCoveredCount > 0 &&
    (coveredMessageCount === null ||
      targetCoveredCount - coveredMessageCount >= SUMMARY_REFRESH_DELTA)
  );
}

export function mergeRecentCoachingMessages(
  storedMessages: CoachingChatMessage[],
  requestMessages: CoachingChatMessage[]
) {
  const stored = compactCoachingMessages(storedMessages);
  const request = compactCoachingMessages(requestMessages);
  if (stored.length === 0) return request;
  if (request.length === 0) return stored;

  const key = (message: CoachingChatMessage) =>
    `${message.role}\u0000${message.content.trim()}`;
  const storedKeys = stored.map(key);
  const requestKeys = request.map(key);
  const sameSequence = (left: string[], right: string[]) =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);

  if (
    requestKeys.length <= storedKeys.length &&
    sameSequence(storedKeys.slice(-requestKeys.length), requestKeys)
  ) {
    return stored;
  }
  if (
    storedKeys.length <= requestKeys.length &&
    sameSequence(requestKeys.slice(-storedKeys.length), storedKeys)
  ) {
    return request;
  }

  for (
    let overlap = Math.min(stored.length, request.length);
    overlap > 0;
    overlap -= 1
  ) {
    if (
      sameSequence(
        storedKeys.slice(-overlap),
        requestKeys.slice(0, overlap)
      )
    ) {
      return compactCoachingMessages([
        ...stored,
        ...request.slice(overlap),
      ]);
    }
  }

  const sameLatestMessage =
    storedKeys.at(-1) === requestKeys.at(-1);
  if (sameLatestMessage && request.length > 1) {
    return request;
  }

  return compactCoachingMessages([...stored, ...request]);
}

export function shouldPreferRequestOnlyContext(params: {
  latestStoredMessageCreatedAt: string | null;
  storedMessages: CoachingChatMessage[];
  requestMessages: CoachingChatMessage[];
}) {
  const latestStoredAt = Date.parse(params.latestStoredMessageCreatedAt || '');
  if (!Number.isFinite(latestStoredAt)) return false;
  if (Date.now() - latestStoredAt < STALE_CONTEXT_RESET_MS) return false;

  const compactRequest = compactCoachingMessages(params.requestMessages);
  const latestRequest = compactRequest.at(-1)?.content || '';
  if (!latestRequest) return false;
  if (CONTINUATION_REQUEST_PATTERN.test(latestRequest)) return false;

  const requestDomains = detectContextDomains(latestRequest);
  if (requestDomains.size === 0) return false;

  const storedContext = compactCoachingMessages(params.storedMessages)
    .map((message) => message.content)
    .join('\n');
  const storedDomains = detectContextDomains(storedContext);
  if (storedDomains.size === 0) return false;

  return ![...requestDomains].some((domain) => storedDomains.has(domain));
}

async function createAndStoreMemory(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  memoryRowId: string | null;
  previousMemory: MemoryPayload | null;
  targetCoveredCount: number;
}) {
  const memory = await createMemory(params);
  if (!memory) return params.previousMemory;

  await storeMemory({
    supabaseAdmin: params.supabaseAdmin,
    sessionId: params.sessionId,
    memoryRowId: params.memoryRowId,
    memory,
  });

  return memory;
}

async function createMemory(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  previousMemory: MemoryPayload | null;
  targetCoveredCount: number;
}) {
  const refreshSignal = AbortSignal.timeout(SESSION_MEMORY_REFRESH_TIMEOUT_MS);
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
    .range(startIndex, endIndex)
    .abortSignal(refreshSignal);

  if (error) {
    console.error('Failed to load messages for session memory:', error);
    return null;
  }

  const sourceMessages = toCoachingMessages((data || []) as StoredMessage[]);
  return buildMemoryPayload({
    previousMemory: params.previousMemory,
    sourceMessages,
    omittedEarlierMessages: startIndex,
    targetCoveredCount: params.targetCoveredCount,
  });
}

function buildMemoryPayload(params: {
  previousMemory: MemoryPayload | null;
  sourceMessages: CoachingChatMessage[];
  omittedEarlierMessages: number;
  targetCoveredCount: number;
}): MemoryPayload {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    coveredMessageCount: params.targetCoveredCount,
    summary: buildDeterministicSummary({
      previousSummary: params.previousMemory?.summary || '',
      sourceMessages: params.sourceMessages,
      omittedEarlierMessages: params.omittedEarlierMessages,
    }),
  };
}

async function storeMemory(params: {
  supabaseAdmin: SupabaseClient;
  sessionId: string;
  memoryRowId: string | null;
  memory: MemoryPayload;
}) {
  const refreshSignal = AbortSignal.timeout(SESSION_MEMORY_REFRESH_TIMEOUT_MS);
  const memoryQuery = params.supabaseAdmin.from('chat_messages');
  const { error: storeError } = params.memoryRowId
    ? await memoryQuery
        .update({
          content: serializeMemoryPayload(params.memory),
          created_at: params.memory.generatedAt,
        })
        .eq('id', params.memoryRowId)
        .eq('session_id', params.sessionId)
        .abortSignal(refreshSignal)
    : await memoryQuery.insert({
        session_id: params.sessionId,
        role: 'system',
        content: serializeMemoryPayload(params.memory),
      }).abortSignal(refreshSignal);

  if (storeError) {
    console.error('Failed to store coaching session memory:', storeError);
    return false;
  }

  return true;
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

  const durableUserTopics = uniqueByValue([
    ...userMessages.slice(0, 6),
    ...userMessages.slice(-18),
  ])
    .map((text) => `- ${clipText(text, 120)}`)
    .join('\n');
  const recentAssistantDirections = uniqueByValue(assistantMessages.slice(-8))
    .map((text) => `- ${clipText(text, 140)}`)
    .join('\n');
  const previousHighlights = normalizePreviousSummary(
    params.previousSummary
  );

  const sections = [
    previousHighlights && params.omittedEarlierMessages > 0
      ? `前回までの保存済み要約:\n${previousHighlights}`
      : '',
    params.omittedEarlierMessages > 0
      ? `注記: さらに古い${params.omittedEarlierMessages}件の会話は要約済みまたは安全のため省略。`
      : '',
    durableUserTopics
      ? `ユーザーが話した事実・希望・未解決点:\n${durableUserTopics}`
      : '',
    recentAssistantDirections
      ? `直近でコーチが扱っていた方向性:\n${recentAssistantDirections}`
      : '',
  ].filter(Boolean);

  return clipText(sections.join('\n\n'), SUMMARY_CHAR_LIMIT);
}

function normalizePreviousSummary(summary: string) {
  if (!summary.trim()) return '';

  const structuralLine =
    /^(?:前回までの保存済み要約:|注記:.*|ユーザーが話した事実・希望・未解決点:|直近でコーチが扱っていた方向性:)$/;
  const highlights = uniqueByValue(
    summary
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !structuralLine.test(line))
      .map((line) => (line.startsWith('- ') ? line : `- ${line}`))
  );

  return clipText(highlights.join('\n'), 900);
}

function serializeMemoryPayload(memory: MemoryPayload) {
  return `${COACHING_SESSION_MEMORY_PREFIX}\n${JSON.stringify(memory)}`;
}

function parseMemoryPayload(content?: string | null): MemoryPayload | null {
  if (!content?.startsWith(COACHING_SESSION_MEMORY_PREFIX)) return null;

  try {
    const json = content.slice(COACHING_SESSION_MEMORY_PREFIX.length).trim();
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

function detectContextDomains(text: string) {
  const normalized = normalizeText(text);
  const matches = new Set<keyof typeof CONTEXT_DOMAIN_PATTERNS>();
  (
    Object.entries(CONTEXT_DOMAIN_PATTERNS) as Array<
      [keyof typeof CONTEXT_DOMAIN_PATTERNS, RegExp]
    >
  ).forEach(([domain, pattern]) => {
    if (pattern.test(normalized)) {
      matches.add(domain);
    }
  });
  return matches;
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
