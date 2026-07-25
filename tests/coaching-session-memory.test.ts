import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildCoachingSessionContext,
  mergeRecentCoachingMessages,
  shouldRefreshSessionMemory,
} from '../src/lib/coaching-session-memory';

describe('mergeRecentCoachingMessages', () => {
  it('DB側が直前のAI回答を欠いている時はリクエスト側の最新履歴を使う', () => {
    const current = { role: 'user' as const, content: '次の質問です。' };
    const merged = mergeRecentCoachingMessages(
      [
        { role: 'user', content: '最初の相談です。' },
        { role: 'assistant', content: '最初の回答です。' },
        current,
      ],
      [
        { role: 'user', content: '最初の相談です。' },
        { role: 'assistant', content: '最初の回答です。' },
        { role: 'user', content: '今夜の一言を教えてください。' },
        { role: 'assistant', content: '直前に提案した一言です。' },
        current,
      ]
    );

    expect(merged).toContainEqual({
      role: 'assistant',
      content: '直前に提案した一言です。',
    });
    expect(merged.at(-1)).toEqual(current);
  });

  it('リクエストが現在の一文だけならDB側の会話履歴を保持する', () => {
    const current = { role: 'user' as const, content: '次の質問です。' };
    const merged = mergeRecentCoachingMessages(
      [
        { role: 'user', content: '前の相談です。' },
        { role: 'assistant', content: '前の回答です。' },
        current,
      ],
      [current]
    );

    expect(merged).toHaveLength(3);
    expect(merged[1].content).toBe('前の回答です。');
  });

  it('同じ末尾履歴を二重に追加しない', () => {
    const history = [
      { role: 'user' as const, content: '相談です。' },
      { role: 'assistant' as const, content: '回答です。' },
      { role: 'user' as const, content: '続きです。' },
    ];

    expect(mergeRecentCoachingMessages(history, history)).toEqual(history);
  });
});

describe('shouldRefreshSessionMemory', () => {
  it('直近24件を超えた最初の時点から要約を作る', () => {
    expect(shouldRefreshSessionMemory(24, null)).toBe(false);
    expect(shouldRefreshSessionMemory(25, null)).toBe(true);
  });

  it('25〜119件の会話でも古い発言との空白を残さない', () => {
    expect(shouldRefreshSessionMemory(40, 15)).toBe(true);
    expect(shouldRefreshSessionMemory(80, 55)).toBe(true);
    expect(shouldRefreshSessionMemory(119, 94)).toBe(true);
  });

  it('直近24件より前をすべてカバー済みなら書き直さない', () => {
    expect(shouldRefreshSessionMemory(80, 56)).toBe(false);
  });
});

describe('buildCoachingSessionContext', () => {
  it('初回の長期履歴は返信前の文脈へ含め、DB保存だけ完了後へ渡す', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const recentMessages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `直近メッセージ${index + 1}`,
      created_at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    }));
    const sourceMessages = Array.from({ length: 57 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content:
        index === 44
          ? '大切にしている猫の名前はミントです。'
          : `要約対象メッセージ${index + 1}`,
      created_at: new Date(1_699_000_000_000 + index * 1000).toISOString(),
    }));
    const sessionQuery = createAwaitableQuery({
      data: { id: sessionId },
      error: null,
    });
    const countQuery = createAwaitableQuery({
      data: null,
      error: null,
      count: 81,
    });
    const memoryQuery = createAwaitableQuery({ data: [], error: null });
    const recentQuery = createAwaitableQuery({
      data: recentMessages.slice().reverse(),
      error: null,
    });
    const sourceQuery = createAwaitableQuery({
      data: sourceMessages,
      error: null,
    });
    const writeQuery = createAwaitableQuery({ data: null, error: null });
    const chatQueries = [
      countQuery,
      memoryQuery,
      recentQuery,
      sourceQuery,
      writeQuery,
    ];
    const from = vi.fn((table: string) => {
      if (table === 'chat_sessions') return sessionQuery;
      if (table === 'chat_messages') {
        const query = chatQueries.shift();
        if (query) return query;
      }
      throw new Error(`Unexpected table call: ${table}`);
    });
    let scheduledTask: (() => Promise<void>) | null = null;
    const scheduleMemoryRefresh = vi.fn((task: () => Promise<void>) => {
      scheduledTask = task;
    });

    const result = await buildCoachingSessionContext({
      supabaseAdmin: { from } as unknown as SupabaseClient,
      sessionId,
      userId: '11111111-1111-4111-8111-111111111111',
      requestMessages: [{ role: 'user', content: '最新の相談です。' }],
      scheduleMemoryRefresh,
    });

    expect(result).toMatchObject({
      totalStoredMessages: 81,
      memoryUsed: true,
      memoryRefreshed: false,
      memoryRefreshScheduled: true,
      memoryCoveredMessages: 57,
    });
    expect(result.messages[0].content).toContain('ミント');
    expect(scheduleMemoryRefresh).toHaveBeenCalledTimes(1);
    expect(recentQuery.limit).toHaveBeenCalledWith(32);
    expect(sourceQuery.range).toHaveBeenCalledWith(0, 56);
    expect(writeQuery.insert).not.toHaveBeenCalled();

    await scheduledTask!();

    expect(writeQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: sessionId,
        role: 'system',
        content: expect.stringContaining('ACTI_SESSION_MEMORY_V1'),
      })
    );
  });

  it('保存済み要約から押し出された直後の一件を返信前に補完する', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const loadedMessages = Array.from({ length: 32 }, (_, index) => {
      const storedIndex = 49 + index;
      return {
        role: storedIndex % 2 === 0 ? 'user' : 'assistant',
        content:
          storedIndex === 56
            ? '毎月の支払い日は25日です。'
            : `保存メッセージ${storedIndex + 1}`,
        created_at: new Date(
          1_700_000_000_000 + storedIndex * 1000
        ).toISOString(),
      };
    });
    const sourceMessages = Array.from({ length: 57 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content:
        index === 56
          ? '毎月の支払い日は25日です。'
          : `要約対象メッセージ${index + 1}`,
      created_at: new Date(1_699_000_000_000 + index * 1000).toISOString(),
    }));
    const memoryContent = `ACTI_SESSION_MEMORY_V1\n${JSON.stringify({
      version: 1,
      generatedAt: '2026-07-25T00:00:00.000Z',
      coveredMessageCount: 56,
      summary: '以前の会話の要約です。',
    })}`;
    const sessionQuery = createAwaitableQuery({
      data: { id: sessionId },
      error: null,
    });
    const countQuery = createAwaitableQuery({
      data: null,
      error: null,
      count: 81,
    });
    const memoryQuery = createAwaitableQuery({
      data: [{ id: 'memory-row-id', content: memoryContent }],
      error: null,
    });
    const recentQuery = createAwaitableQuery({
      data: loadedMessages.slice().reverse(),
      error: null,
    });
    const sourceQuery = createAwaitableQuery({
      data: sourceMessages,
      error: null,
    });
    const writeQuery = createAwaitableQuery({ data: null, error: null });
    const chatQueries = [
      countQuery,
      memoryQuery,
      recentQuery,
      sourceQuery,
      writeQuery,
    ];
    const from = vi.fn((table: string) => {
      if (table === 'chat_sessions') return sessionQuery;
      if (table === 'chat_messages') {
        const query = chatQueries.shift();
        if (query) return query;
      }
      throw new Error(`Unexpected table call: ${table}`);
    });
    let scheduledTask: (() => Promise<void>) | null = null;

    const result = await buildCoachingSessionContext({
      supabaseAdmin: { from } as unknown as SupabaseClient,
      sessionId,
      userId: '11111111-1111-4111-8111-111111111111',
      requestMessages: [{ role: 'user', content: '支払い日は何日ですか？' }],
      scheduleMemoryRefresh: (task) => {
        scheduledTask = task;
      },
    });

    expect(result).toMatchObject({
      totalStoredMessages: 81,
      memoryUsed: true,
      memoryRefreshed: false,
      memoryRefreshScheduled: true,
      memoryCoveredMessages: 57,
    });
    expect(result.messages[0].content).toContain('25日');
    expect(sourceQuery.range).not.toHaveBeenCalled();
    expect(writeQuery.update).not.toHaveBeenCalled();

    await scheduledTask!();

    expect(sourceQuery.range).toHaveBeenCalledWith(0, 56);
    expect(writeQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('ACTI_SESSION_MEMORY_V1'),
      })
    );
  });
});

function createAwaitableQuery(result: Record<string, unknown>) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: PromiseLike<Record<string, unknown>>['then'];
  } = {};
  [
    'select',
    'eq',
    'in',
    'like',
    'order',
    'limit',
    'range',
    'insert',
    'update',
    'abortSignal',
  ].forEach((method) => {
    query[method] = vi.fn(() => query);
  });
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  query.then = (onFulfilled, onRejected) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return query;
}
