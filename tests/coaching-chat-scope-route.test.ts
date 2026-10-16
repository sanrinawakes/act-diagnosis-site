import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { COACHING_SCOPE_GUIDANCE } from '../src/lib/coaching-scope';
import { getJapanMonthStartKey } from '../src/lib/japan-date';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  createServerClient: vi.fn(),
  createJsonLineStream: vi.fn(),
  generateCoachingText: vi.fn(),
  buildGeminiParts: vi.fn(),
  compactCoachingMessages: vi.fn(),
  buildSessionContext: vi.fn(),
  usageInsert: vi.fn(),
  quotaRpc: vi.fn(),
  profileSingle: vi.fn(),
  profileCount: 9,
  sessionOwners: new Map<string, string>(),
  sessionLookup: vi.fn(),
  sessionLookupError: false,
  sessionLookupPending: false,
  chatMessageAccess: vi.fn(),
  sessionWrite: vi.fn(),
  accessExpiresAt: '2099-12-31T00:00:00.000Z',
  paidTestCredits: 0,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createServiceClient,
}));

vi.mock('../src/lib/supabase-server', () => ({
  createServerClient: mocks.createServerClient,
}));

vi.mock('../src/lib/coaching-gemini', () => ({
  buildGeminiParts: mocks.buildGeminiParts,
  compactCoachingMessages: mocks.compactCoachingMessages,
  createJsonLineStream: mocks.createJsonLineStream,
  generateCoachingText: mocks.generateCoachingText,
  getStreamHeaders: () => ({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  }),
}));

vi.mock('../src/lib/coaching-session-memory', () => ({
  buildCoachingSessionContext: mocks.buildSessionContext,
}));

import { POST } from '../src/app/api/chat/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const FOREIGN_USER_ID = '55555555-5555-4555-8555-555555555555';

describe('POST /api/chat scope guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileCount = 9;
    mocks.sessionOwners = new Map([
      [SESSION_ID, USER_ID],
      [FOREIGN_SESSION_ID, FOREIGN_USER_ID],
    ]);
    mocks.sessionLookupError = false;
    mocks.sessionLookupPending = false;
    mocks.accessExpiresAt = '2099-12-31T00:00:00.000Z';
    mocks.paidTestCredits = 0;
    mocks.profileSingle.mockImplementation(async () => ({
      data: {
        chat_count_month: mocks.profileCount,
        chat_month_start: getJapanMonthStartKey(),
        role: 'member',
        subscription_status: 'active',
        is_active: true,
        paid_test_credits: mocks.paidTestCredits,
        awakes_access_expires_at: mocks.accessExpiresAt,
      },
      error: null,
    }));

    mocks.createServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: USER_ID } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table !== 'site_settings') {
          throw new Error(`Unexpected browser client table: ${table}`);
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

    const serviceClient = {
      rpc: mocks.quotaRpc,
      from: vi.fn((table: string) => {
        if (table === 'profiles') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: mocks.profileSingle,
              })),
            })),
          };
        }
        if (table === 'chat_sessions') {
          const filters: Record<string, unknown> = {};
          const query = {
            select: vi.fn(),
            eq: vi.fn(),
            maybeSingle: vi.fn(() => {
              mocks.sessionLookup({ ...filters });
              if (mocks.sessionLookupPending) return new Promise(() => {});
              if (mocks.sessionLookupError) {
                return Promise.resolve({
                  data: null,
                  error: { message: 'owned-session lookup unavailable' },
                });
              }
              const id = String(filters.id || '');
              return Promise.resolve({
                data:
                  mocks.sessionOwners.get(id) === filters.user_id
                    ? { id }
                    : null,
                error: null,
              });
            }),
            insert: mocks.sessionWrite,
            update: mocks.sessionWrite,
          };
          query.select.mockImplementation(() => query);
          query.eq.mockImplementation((column: string, value: unknown) => {
            filters[column] = value;
            return query;
          });
          return query;
        }
        if (table === 'chat_messages') {
          mocks.chatMessageAccess();
          throw new Error('Unexpected chat_messages access in legacy request');
        }
        if (table === 'coaching_usage_events') {
          return { insert: mocks.usageInsert };
        }
        throw new Error(`Unexpected service client table: ${table}`);
      }),
    };
    mocks.usageInsert.mockResolvedValue({ error: null });
    mocks.quotaRpc.mockResolvedValue({
      data: [
        {
          allowed: true,
          usage_count: 10,
          remaining: 1490,
          reserved_now: true,
        },
      ],
      error: null,
    });
    mocks.createServiceClient.mockReturnValue(serviceClient);
    mocks.compactCoachingMessages.mockImplementation((messages) => messages);
    mocks.buildGeminiParts.mockImplementation((text) => [{ text }]);
    mocks.generateCoachingText.mockResolvedValue({
      text: '相談への回答',
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      completionStatus: 'complete',
      finishReason: 'STOP',
      modelName: 'test-model',
      provider: 'test',
      qualityRepairAttempted: false,
      qualityRepairAccepted: false,
      qualityInitialIssues: [],
      qualityFinalIssues: [],
    });
    mocks.buildSessionContext.mockImplementation(({ requestMessages }) => ({
      messages: requestMessages,
      totalStoredMessages: requestMessages.length,
      memoryUsed: false,
      memoryRefreshed: false,
      memoryRefreshScheduled: false,
      memoryCoveredMessages: null,
    }));
    mocks.createJsonLineStream.mockImplementation(() => {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: 'done',
                message: '相談への回答',
                completionStatus: 'complete',
              })}\n`
            )
          );
          controller.close();
        },
      });
    });
  });

  const ownershipDeniedBody = {
    error: '保存済みの相談内容を確認できませんでした。',
  };
  const ownershipUnavailableBody = {
    error: '相談内容を確認できませんでした。少し待ってから、もう一度送信してください。',
  };

  const foreignCases = [
    { label: 'allowed JSON foreign session', stream: false, blocked: false },
    { label: 'allowed stream foreign session', stream: true, blocked: false },
    { label: 'blocked JSON foreign session', stream: false, blocked: true },
    { label: 'blocked stream foreign session', stream: true, blocked: true },
  ];
  it.each(foreignCases)('rejects legacy $label before side effects', async (testCase) => {
    const body = legacyRequestBody(FOREIGN_SESSION_ID, testCase.stream, testCase.blocked);
    const witness = await observeLegacyRequest(testCase.label, body);

    expect(witness.status).toBe(400);
    expect(witness.parsedBody).toEqual(ownershipDeniedBody);
    expect(witness.sessionLookups).toEqual([{ id: FOREIGN_SESSION_ID, user_id: USER_ID }]);
    expectNoLegacySideEffects(witness.effects);
  });

  it('rejects a missing legacy session with the same non-enumerating error', async () => {
    const body = legacyRequestBody(MISSING_SESSION_ID, false);
    const witness = await observeLegacyRequest('missing legacy session', body);

    expect(witness.status).toBe(400);
    expect(witness.parsedBody).toEqual(ownershipDeniedBody);
    expectNoLegacySideEffects(witness.effects);
  });

  it('checks the legacy session_id alias before side effects', async () => {
    const { sessionId: _sessionId, ...rest } = legacyRequestBody(FOREIGN_SESSION_ID, true);
    expect(_sessionId).toBe(FOREIGN_SESSION_ID);
    const body = { ...rest, session_id: FOREIGN_SESSION_ID };
    const witness = await observeLegacyRequest('foreign session_id alias', body);

    expect(witness.status).toBe(400);
    expect(witness.parsedBody).toEqual(ownershipDeniedBody);
    expect(witness.sessionLookups).toEqual([{ id: FOREIGN_SESSION_ID, user_id: USER_ID }]);
    expectNoLegacySideEffects(witness.effects);
  });

  it('fails closed on legacy ownership lookup errors before side effects', async () => {
    mocks.sessionLookupError = true;
    const body = legacyRequestBody(SESSION_ID, false);
    const witness = await observeLegacyRequest('ownership lookup error', body);

    expect(witness.status).toBe(503);
    expect(witness.parsedBody).toEqual(ownershipUnavailableBody);
    expectNoLegacySideEffects(witness.effects);
  });

  it('bounds a stalled legacy ownership lookup before side effects', async () => {
    vi.useFakeTimers();
    try {
      mocks.sessionLookupPending = true;
      const body = legacyRequestBody(SESSION_ID, true);
      const startedAt = Date.now();
      const observed = observeLegacyRequest('ownership lookup timeout', body, startedAt);
      await vi.advanceTimersByTimeAsync(8001);
      const witness = await observed;

      expect(witness.status).toBe(504);
      expect(witness.parsedBody).toEqual(ownershipUnavailableBody);
      expect(witness.elapsedMs).toBeGreaterThanOrEqual(8000);
      expect(witness.elapsedMs).toBeLessThanOrEqual(8001);
      expectNoLegacySideEffects(witness.effects);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('keeps an owned legacy session compatible (stream=%s)', async (stream) => {
    const body = legacyRequestBody(SESSION_ID, stream);
    const witness = await observeLegacyRequest(`owned legacy stream=${stream}`, body);

    expect(witness.status).toBe(200);
    expect(witness.effects).toEqual({
      quotaRpc: 1,
      usageInsert: 1,
      context: 1,
      generateText: stream ? 0 : 1,
      generateStream: stream ? 1 : 0,
      chatMessages: 0,
      sessionWrites: 0,
    });
    expect(mocks.usageInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      session_id: SESSION_ID,
    }));
    expect(witness.responseBody).toContain('相談への回答');
  });

  it.each([false, true])('keeps sessionless legacy compatible (stream=%s)', async (stream) => {
    const body = legacyRequestBody(undefined, stream);
    const witness = await observeLegacyRequest(`sessionless legacy stream=${stream}`, body);

    expect(witness.status).toBe(200);
    expect(witness.sessionLookups).toEqual([]);
    expect(witness.effects).toEqual({
      quotaRpc: 1,
      usageInsert: 1,
      context: 1,
      generateText: stream ? 0 : 1,
      generateStream: stream ? 1 : 0,
      chatMessages: 0,
      sessionWrites: 0,
    });
    expect(mocks.usageInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      session_id: null,
    }));
    expect(witness.responseBody).toContain('相談への回答');
  });

  function legacyRequestBody(sessionId: string | undefined, stream: boolean, blocked = false) {
    return {
      ...(sessionId ? { sessionId } : {}),
      messages: [{
        role: 'user',
        content: blocked ? '広告の文章を3案作って' : '夫との関係で悩んでいます。どう伝えればいいですか？',
      }],
      stream,
    };
  }

  async function observeLegacyRequest(label: string, body: Record<string, unknown>, startedAt = Date.now()) {
    const response = await POST(new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    }));
    const responseBody = await response.text();
    const witness = {
      label,
      requestBody: body,
      status: response.status,
      responseBody,
      parsedBody: response.headers.get('content-type')?.includes('application/x-ndjson')
        ? responseBody.trim().split('\n').map((line) => JSON.parse(line))
        : JSON.parse(responseBody),
      elapsedMs: Date.now() - startedAt,
      sessionLookups: mocks.sessionLookup.mock.calls.map(([filters]) => filters),
      effects: {
        quotaRpc: mocks.quotaRpc.mock.calls.length,
        usageInsert: mocks.usageInsert.mock.calls.length,
        context: mocks.buildSessionContext.mock.calls.length,
        generateText: mocks.generateCoachingText.mock.calls.length,
        generateStream: mocks.createJsonLineStream.mock.calls.length,
        chatMessages: mocks.chatMessageAccess.mock.calls.length,
        sessionWrites: mocks.sessionWrite.mock.calls.length,
      },
    };
    // Preserve actual fake-route observations before any assertion, including on the old route.
    console.info('LEGACY_OWNER_GUARD_WITNESS', JSON.stringify(witness));
    const localCaseEvidence = process.env.ACTI_GUARD_DRAFT_CASE_EVIDENCE;
    if (localCaseEvidence) {
      appendFileSync(localCaseEvidence, JSON.stringify(witness) + '\n', { mode: 0o600 });
    }
    return witness;
  }

  function expectNoLegacySideEffects(effects: Record<string, number>) {
    expect(effects).toEqual({
      quotaRpc: 0,
      usageInsert: 0,
      context: 0,
      generateText: 0,
      generateStream: 0,
      chatMessages: 0,
      sessionWrites: 0,
    });
  }

  it('rejects an expired AWAKES member before quota or AI, even with a paid diagnosis credit', async () => {
    mocks.accessExpiresAt = '2020-01-01T00:00:00.000Z';
    mocks.paidTestCredits = 1;

    const response = await POST(createAllowedRequest(true));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'AWAKES会員期限または利用権限を確認できません。',
    });
    expect(mocks.quotaRpc).not.toHaveBeenCalled();
    expect(mocks.generateCoachingText).not.toHaveBeenCalled();
  });

  it('records and returns a blocked stream without calling an AI provider', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        messages: [{ role: 'user', content: '広告の文章を3案作って' }],
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/x-ndjson'
    );
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines[0].text).toBe(COACHING_SCOPE_GUIDANCE);
    expect(lines[1]).toMatchObject({
      type: 'done',
      finishReason: 'SCOPE_BLOCKED',
      scopeDecision: 'blocked',
      scopeCategory: 'marketing_content',
      remaining: 1491,
    });
    expect(mocks.createJsonLineStream).not.toHaveBeenCalled();
    expect(mocks.generateCoachingText).not.toHaveBeenCalled();
    expect(mocks.quotaRpc).not.toHaveBeenCalled();
    expect(mocks.usageInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        session_id: SESSION_ID,
        decision: 'blocked',
        category: 'marketing_content',
        provider_requested: false,
        message_chars: '広告の文章を3案作って'.length,
      })
    );
  });

  it('records a personal consultation and sends it to the normal provider path', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        messages: [
          {
            role: 'user',
            content: '夫との関係で悩んでいます。どう伝えればいいですか？',
          },
        ],
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('相談への回答');
    expect(mocks.createJsonLineStream).toHaveBeenCalledTimes(1);
    expect(mocks.quotaRpc).toHaveBeenCalledWith(
      'reserve_coaching_monthly_usage',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_limit: 1500,
        p_period_start: getJapanMonthStartKey(),
      })
    );
    expect(mocks.usageInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allowed',
        category: 'coaching',
        provider_requested: true,
      })
    );
  });

  it('retries a transient profile timeout once before returning 504', async () => {
    mocks.profileSingle
      .mockRejectedValueOnce(new Error('PROFILE_TIMEOUT'))
      .mockResolvedValueOnce({
        data: {
          chat_count_month: mocks.profileCount,
          chat_month_start: getJapanMonthStartKey(),
          role: 'member',
          subscription_status: 'active',
          is_active: true,
          paid_test_credits: mocks.paidTestCredits,
          awakes_access_expires_at: mocks.accessExpiresAt,
        },
        error: null,
      });

    const response = await POST(createAllowedRequest(false));

    expect(response.status).toBe(200);
    expect(mocks.profileSingle).toHaveBeenCalledTimes(2);
  });

  it('keeps a family legal drafting follow-up on the provider path', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        messages: [
          {
            role: 'user',
            content:
              '平日夕食交流についての文がないからそれも作成してほしい。前回も伝えているが必ず週１回食事をさせろということではない。',
          },
          {
            role: 'assistant',
            content:
              '大変失礼いたしました。ご指示いただいた内容を文章としてまとめました。',
          },
          {
            role: 'user',
            content:
              '宿泊についての文章も書いてほしい。これについても子供が望んでいないものを強制的にさせろなんて一言も言っていない。',
          },
        ],
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(COACHING_SCOPE_GUIDANCE);
    expect(mocks.createJsonLineStream).toHaveBeenCalledTimes(1);
    expect(mocks.usageInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allowed',
        category: 'coaching',
        provider_requested: true,
      })
    );
  });

  it('blocks business-growth consulting before the provider path runs', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        messages: [
          {
            role: 'user',
            content:
              'nirvanaのコンセプトで、月に50万稼げるようにコンサルしてほしい',
          },
        ],
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines[0].text).toBe(COACHING_SCOPE_GUIDANCE);
    expect(lines[1]).toMatchObject({
      finishReason: 'SCOPE_BLOCKED',
      scopeDecision: 'blocked',
      scopeCategory: 'marketing_content',
    });
    expect(mocks.generateCoachingText).not.toHaveBeenCalled();
    expect(mocks.quotaRpc).not.toHaveBeenCalled();
    expect(mocks.usageInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'blocked',
        category: 'marketing_content',
        provider_requested: false,
      })
    );
  });

  it('blocks an in-progress startup how-to request before any provider call runs', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        messages: [
          {
            role: 'user',
            content:
              '【入力中】自分は本当にこれから01で起業するんだけどそのやり方とか最初からどうやったらこういうマインドで起業したらいいよとかそういうの全部教えてくれた',
          },
        ],
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines[0].text).toBe(COACHING_SCOPE_GUIDANCE);
    expect(lines[1]).toMatchObject({
      finishReason: 'SCOPE_BLOCKED',
      scopeDecision: 'blocked',
      scopeCategory: 'marketing_content',
    });
    expect(mocks.generateCoachingText).not.toHaveBeenCalled();
    expect(mocks.quotaRpc).not.toHaveBeenCalled();
    expect(mocks.usageInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'blocked',
        category: 'marketing_content',
        provider_requested: false,
      })
    );
  });

  it('allows the 1500th request and returns zero remaining', async () => {
    mocks.profileCount = 1499;
    mocks.quotaRpc.mockResolvedValueOnce({
      data: [
        {
          allowed: true,
          usage_count: 1500,
          remaining: 0,
          reserved_now: true,
        },
      ],
      error: null,
    });

    const response = await POST(createAllowedRequest(false));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ remaining: 0, limit: 1500 });
  });

  it('rejects a request immediately when the monthly snapshot is already 1500', async () => {
    mocks.profileCount = 1500;

    const response = await POST(createAllowedRequest(true));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error:
        '今月の利用上限（1500回）に達しました。翌月1日から再びご利用いただけます。',
      remaining: 0,
      limit: 1500,
    });
    expect(mocks.quotaRpc).not.toHaveBeenCalled();
    expect(mocks.createJsonLineStream).not.toHaveBeenCalled();
  });

  it('rejects a concurrently arriving 1501st request using the database result', async () => {
    mocks.profileCount = 1499;
    mocks.quotaRpc.mockResolvedValueOnce({
      data: [
        {
          allowed: false,
          usage_count: 1500,
          remaining: 0,
          reserved_now: false,
        },
      ],
      error: null,
    });

    const response = await POST(createAllowedRequest(true));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ remaining: 0, limit: 1500 });
    expect(mocks.createJsonLineStream).not.toHaveBeenCalled();
    expect(mocks.usageInsert).not.toHaveBeenCalled();
  });

  it('releases the reserved count when non-stream generation fails', async () => {
    mocks.generateCoachingText.mockRejectedValueOnce(
      new Error('provider unavailable')
    );
    mocks.quotaRpc.mockImplementation((name: string) => {
      if (name === 'reserve_coaching_monthly_usage') {
        return Promise.resolve({
          data: [
            {
              allowed: true,
              usage_count: 10,
              remaining: 1490,
              reserved_now: true,
            },
          ],
          error: null,
        });
      }
      if (name === 'release_coaching_monthly_usage') {
        return Promise.resolve({
          data: [{ released: true, usage_count: 9, remaining: 1491 }],
          error: null,
        });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const response = await POST(createAllowedRequest(false));

    expect(response.status).toBe(502);
    expect(mocks.quotaRpc).toHaveBeenNthCalledWith(
      2,
      'release_coaching_monthly_usage',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_limit: 1500,
        p_period_start: getJapanMonthStartKey(),
      })
    );
  });

  it('does not release an existing idempotent reservation after a retry fails', async () => {
    mocks.generateCoachingText.mockRejectedValueOnce(
      new Error('provider unavailable')
    );
    mocks.quotaRpc.mockResolvedValueOnce({
      data: [
        {
          allowed: true,
          usage_count: 10,
          remaining: 1490,
          reserved_now: false,
        },
      ],
      error: null,
    });

    const response = await POST(createAllowedRequest(false));

    expect(response.status).toBe(502);
    expect(mocks.quotaRpc).toHaveBeenCalledTimes(1);
    expect(mocks.quotaRpc).not.toHaveBeenCalledWith(
      'release_coaching_monthly_usage',
      expect.anything()
    );
  });

  it('accepts an explicit null diagnosis code for legacy sessions', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        messages: [
          {
            role: 'user',
            content: '診断前ですが、今の悩みについて相談してもいいですか？',
          },
        ],
        diagnosisCode: null,
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('相談への回答');
    expect(mocks.createJsonLineStream).toHaveBeenCalledTimes(1);
  });

  it('continues to reject a malformed non-null diagnosis code', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        messages: [
          {
            role: 'user',
            content: '今の悩みについて相談したいです。',
          },
        ],
        diagnosisCode: 'INVALID-9',
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid diagnosis code' });
    expect(mocks.createJsonLineStream).not.toHaveBeenCalled();
  });

  it.each([false, 3, {}, 'MGA-0', 'MGA-7', 'XYZ-3', ' MGA-3 '])(
    'rejects the invalid diagnosis value %j',
    async (diagnosisCode) => {
      const request = new NextRequest('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          messages: [
            {
              role: 'user',
              content: '今の悩みについて相談したいです。',
            },
          ],
          diagnosisCode,
          stream: true,
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid diagnosis code' });
      expect(mocks.createJsonLineStream).not.toHaveBeenCalled();
    }
  );

  it('rejects an incomplete recovery identifier pair', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        requestId: '33333333-3333-4333-8333-333333333333',
        messages: [{ role: 'user', content: '相談したいです。' }],
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'requestId and assistantMessageId must be provided together',
    });
  });

  it('rejects identical user and assistant message IDs', async () => {
    const duplicateId = '33333333-3333-4333-8333-333333333333';
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        requestId: duplicateId,
        assistantMessageId: duplicateId,
        messages: [{ role: 'user', content: '相談したいです。' }],
        stream: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid chat recovery identifiers',
    });
  });

});

function createAllowedRequest(stream: boolean) {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      messages: [
        {
          role: 'user',
          content: '夫との関係で悩んでいます。どう伝えればいいですか？',
        },
      ],
      stream,
    }),
  });
}
