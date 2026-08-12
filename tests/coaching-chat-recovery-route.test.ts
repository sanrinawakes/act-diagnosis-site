import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getJapanMonthStartKey } from '../src/lib/japan-date';

const state = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  createServerClient: vi.fn(),
  createJsonLineStream: vi.fn(),
  generateCoachingText: vi.fn(),
  profileCount: 3,
  completeUpdateError: false,
  chargeable: true,
  messages: new Map<
    string,
    { id: string; session_id: string; role: string; content: string; created_at: string }
  >(),
  usageRequestIds: new Set<string>(),
  quotaRequestIds: new Set<string>(),
  sessionActivity: {
    last_message_at: null as string | null,
    message_count: 0,
  },
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
    generateCoachingText: state.generateCoachingText,
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
    memoryRefreshScheduled: false,
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
    state.completeUpdateError = false;
    state.chargeable = true;
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
    state.quotaRequestIds = new Set();
    state.sessionActivity = {
      last_message_at: null,
      message_count: 0,
    };

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
    state.generateCoachingText.mockImplementation(() =>
      Promise.resolve({
        text: ANSWER,
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        completionStatus: 'complete',
        finishReason: 'STOP',
        modelName: 'test-model',
        provider: 'test',
        qualityRepairAttempted: false,
        qualityRepairAccepted: false,
        qualityInitialIssues: [],
        qualityFinalIssues: [],
        chargeable: state.chargeable ? undefined : false,
      })
    );
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
            chargeable?: boolean;
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
                chargeable: state.chargeable ? undefined : false,
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
    expect(state.sessionActivity.message_count).toBe(2);
    expect(typeof state.sessionActivity.last_message_at).toBe('string');
  });

  it('releases a new reservation when non-stream response saving fails', async () => {
    state.completeUpdateError = true;

    const response = await POST(createRequest(false));

    expect(response.status).toBe(500);
    expect(state.profileCount).toBe(3);
    expect(state.quotaRequestIds.size).toBe(0);
  });

  it('releases a new reservation when stream response saving fails', async () => {
    state.completeUpdateError = true;
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
        return new ReadableStream({
          async start(controller) {
            try {
              await onDone(
                { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
                {
                  message: ANSWER,
                  completionStatus: 'complete',
                  modelName: 'test-model',
                }
              );
            } catch {
              // The real streaming layer turns finalization failures into an
              // error event. This route test verifies the quota side effect.
            }
            controller.close();
          },
        });
      }
    );

    const response = await POST(createRequest(true));
    await response.text();

    expect(response.status).toBe(200);
    expect(state.profileCount).toBe(3);
    expect(state.quotaRequestIds.size).toBe(0);
  });

  it('does not charge a local quality fallback', async () => {
    state.chargeable = false;

    const response = await POST(createRequest(true));
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain('"remaining":1497');
    expect(state.profileCount).toBe(3);
    expect(state.quotaRequestIds.size).toBe(0);
  });

  it('does not charge a local quality fallback without streaming', async () => {
    state.chargeable = false;

    const response = await POST(createRequest(false));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.remaining).toBe(1497);
    expect(state.profileCount).toBe(3);
    expect(state.quotaRequestIds.size).toBe(0);
  });
});

function createRequest(stream = true) {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      assistantMessageId: ASSISTANT_ID,
      messages: [{ role: 'user', content: '仕事について相談したいです。' }],
      stream,
    }),
  });
}

function createServiceClient() {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      const requestId = String(args.p_request_id || '');
      if (name === 'reserve_coaching_monthly_usage') {
        const reservedNow = !state.quotaRequestIds.has(requestId);
        if (reservedNow) {
          state.quotaRequestIds.add(requestId);
          state.profileCount += 1;
        }
        return Promise.resolve({
          data: [
            {
              allowed: true,
              usage_count: state.profileCount,
              remaining: 1500 - state.profileCount,
              reserved_now: reservedNow,
            },
          ],
          error: null,
        });
      }
      if (name === 'release_coaching_monthly_usage') {
        const released = state.quotaRequestIds.delete(requestId);
        if (released) state.profileCount -= 1;
        return Promise.resolve({
          data: [
            {
              released,
              usage_count: state.profileCount,
              remaining: 1500 - state.profileCount,
            },
          ],
          error: null,
        });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
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
                chat_count_month: state.profileCount,
                chat_month_start: getJapanMonthStartKey(),
                role: 'member',
                subscription_status: 'active',
                is_active: true,
                paid_test_credits: 0,
                awakes_access_expires_at: '2099-12-31T00:00:00.000Z',
              },
              error: null,
            }),
          };
        },
      };
    },
  };
}

function createChatSessionsQuery() {
  const filters: Record<string, unknown> = {};
  let updateValues: Record<string, unknown> | null = null;
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    },
    update: (values: Record<string, unknown>) => {
      updateValues = values;
      return chain;
    },
    maybeSingle: async () => ({
      data:
        filters.id === SESSION_ID && filters.user_id === USER_ID
          ? { id: SESSION_ID }
          : null,
      error: null,
    }),
    then: undefined,
  };
  const originalEq = chain.eq;
  chain.eq = (column: string, value: unknown) => {
    filters[column] = value;
    if (updateValues && column === 'id' && value === SESSION_ID) {
      state.sessionActivity = {
        last_message_at:
          typeof updateValues.last_message_at === 'string'
            ? updateValues.last_message_at
            : state.sessionActivity.last_message_at,
        message_count:
          typeof updateValues.message_count === 'number'
            ? updateValues.message_count
            : state.sessionActivity.message_count,
      };
      return Promise.resolve({ error: null }) as never;
    }
    return originalEq(column, value);
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
        if (state.completeUpdateError && updateValues.role === 'assistant') {
          return {
            data: null,
            error: { message: 'response save unavailable' },
          };
        }
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
