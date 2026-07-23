import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  createServerClient: vi.fn(),
  createJsonLineStream: vi.fn(),
  profileCount: 3,
  messages: new Map<
    string,
    { id: string; session_id: string; role: string; content: string; created_at: string }
  >(),
  usageRequestIds: new Set<string>(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: state.createServiceClient,
}));

vi.mock('../src/lib/supabase-server', () => ({
  createServerClient: state.createServerClient,
}));

vi.mock('../src/lib/coaching-gemini', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/lib/coaching-gemini')>();
  return {
    ...actual,
    buildGeminiParts: (text: string) => [{ text }],
    compactCoachingMessages: (messages: unknown[]) => messages,
    createJsonLineStream: state.createJsonLineStream,
  };
});

vi.mock('../src/lib/coaching-session-memory', () => ({
  buildCoachingSessionContext: ({
    requestMessages,
  }: {
    requestMessages: unknown[];
  }) => ({
    messages: requestMessages,
    totalStoredMessages: requestMessages.length,
    memoryUsed: false,
    memoryRefreshed: false,
    memoryCoveredMessages: null,
  }),
}));

import { POST } from '../src/app/api/chat/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const ASSISTANT_ID = '44444444-4444-4444-8444-444444444444';
const ANSWER = '保存済みの回答を再送します。次に何を確かめたいですか？';

describe('POST /api/chat connection recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.profileCount = 3;
    state.messages = new Map([
      [
        REQUEST_ID,
        {
          id: REQUEST_ID,
          session_id: SESSION_ID,
          role: 'user',
          content: '仕事について相談したいです。',
          created_at: new Date().toISOString(),
        },
      ],
    ]);
    state.usageRequestIds = new Set();

    state.createServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: USER_ID } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table !== 'site_settings') {
          throw new Error(`Unexpected browser table: ${table}`);
        }
        return {
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { bot_enabled: true },
              error: null,
            }),
          })),
        };
      }),
    });
    state.createServiceClient.mockReturnValue(createServiceClient());
    state.createJsonLineStream.mockImplementation(
      ({
        onDone,
      }: {
        onDone: (
          usage: Record<string, number>,
          completion: {
            message: string;
            completionStatus: 'complete';
            modelName: string;
          }
        ) => Promise<Record<string, unknown>>;
      }) => {
        const encoder = new TextEncoder();
        return new ReadableStream({
          async start(controller) {
            const finalization = await onDone(
              { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
              {
                message: ANSWER,
                completionStatus: 'complete',
                modelName: 'test-model',
              }
            );
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({
                  type: 'chunk',
                  text: ANSWER,
                  verified: true,
                })}\n`
              )
            );
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({
                  type: 'done',
                  message: ANSWER,
                  completionStatus: 'complete',
                  finalizationStatus: 'complete',
                  ...finalization,
                })}\n`
              )
            );
            controller.close();
          },
        });
      }
    );
  });

  it('generates once, persists the response, and replays it without double counting', async () => {
    const firstResponse = await POST(createRequest());
    const firstText = await firstResponse.text();
    const secondResponse = await POST(createRequest());
    const secondText = await secondResponse.text();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstText).toContain(ANSWER);
    expect(secondText).toContain(ANSWER);
    expect(secondResponse.headers.get('x-acti-chat-status')).toBe('replayed');
    expect(state.createJsonLineStream).toHaveBeenCalledTimes(1);
    expect(state.profileCount).toBe(4);
    expect(state.usageRequestIds).toEqual(new Set([REQUEST_ID]));
    expect(state.messages.get(ASSISTANT_ID)).toMatchObject({
      role: 'assistant',
      content: ANSWER,
    });
  });
});

function createRequest() {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      assistantMessageId: ASSISTANT_ID,
      messages: [{ role: 'user', content: '仕事について相談したいです。' }],
      stream: true,
    }),
  });
}

function createServiceClient() {
  return {
    from(table: string) {
      if (table === 'profiles') return createProfilesQuery();
      if (table === 'chat_sessions') return createChatSessionsQuery();
      if (table === 'chat_messages') return createChatMessagesQuery();
      if (table === 'coaching_usage_events') {
        return {
          insert(row: { request_id: string }) {
            if (state.usageRequestIds.has(row.request_id)) {
              return Promise.resolve({
                error: { code: '23505', message: 'duplicate' },
              });
            }
            state.usageRequestIds.add(row.request_id);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Unexpected service table: ${table}`);
    },
  };
}

function createProfilesQuery() {
  return {
    select() {
      return {
        eq() {
          return {
            single: async () => ({
              data: {
                chat_count_today: state.profileCount,
                last_chat_date: new Date().toISOString().slice(0, 10),
                role: 'member',
                subscription_status: 'active',
                is_active: true,
                paid_test_credits: 0,
              },
              error: null,
            }),
          };
        },
      };
    },
    update(values: { chat_count_today: number }) {
      return {
        eq: async () => {
          state.profileCount = values.chat_count_today;
          return { error: null };
        },
      };
    },
  };
}

function createChatSessionsQuery() {
  const filters: Record<string, unknown> = {};
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    },
    maybeSingle: async () => ({
      data:
        filters.id === SESSION_ID && filters.user_id === USER_ID
          ? { id: SESSION_ID }
          : null,
      error: null,
    }),
  };
  return chain;
}

function createChatMessagesQuery() {
  const filters: Record<string, unknown> = {};
  let updateValues: Record<string, unknown> | null = null;
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    },
    maybeSingle: async () => {
      const row = state.messages.get(String(filters.id || ''));
      if (!row || !matches(row, filters)) return { data: null, error: null };
      if (updateValues) {
        const updated = { ...row, ...updateValues };
        state.messages.set(row.id, updated);
        return { data: { id: row.id }, error: null };
      }
      return { data: row, error: null };
    },
    update: (values: Record<string, unknown>) => {
      updateValues = values;
      return chain;
    },
    insert: async (row: {
      id: string;
      session_id: string;
      role: string;
      content: string;
    }) => {
      if (state.messages.has(row.id)) {
        return { error: { code: '23505', message: 'duplicate' } };
      }
      state.messages.set(row.id, {
        ...row,
        created_at: new Date().toISOString(),
      });
      return { error: null };
    },
  };
  return chain;
}

function matches(
  row: Record<string, unknown>,
  filters: Record<string, unknown>
) {
  return Object.entries(filters).every(([key, value]) => row[key] === value);
}
