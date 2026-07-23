import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { COACHING_SCOPE_GUIDANCE } from '../src/lib/coaching-scope';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  createServerClient: vi.fn(),
  createJsonLineStream: vi.fn(),
  generateCoachingText: vi.fn(),
  buildGeminiParts: vi.fn(),
  compactCoachingMessages: vi.fn(),
  buildSessionContext: vi.fn(),
  usageInsert: vi.fn(),
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

describe('POST /api/chat scope guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
      from: vi.fn((table: string) => {
        if (table === 'profiles') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: {
                    chat_count_today: 9,
                    last_chat_date: new Date().toISOString().slice(0, 10),
                    role: 'member',
                    subscription_status: 'active',
                    is_active: true,
                    paid_test_credits: 0,
                  },
                  error: null,
                }),
              })),
            })),
          };
        }
        if (table === 'coaching_usage_events') {
          return { insert: mocks.usageInsert };
        }
        throw new Error(`Unexpected service client table: ${table}`);
      }),
    };
    mocks.usageInsert.mockResolvedValue({ error: null });
    mocks.createServiceClient.mockReturnValue(serviceClient);
    mocks.compactCoachingMessages.mockImplementation((messages) => messages);
    mocks.buildGeminiParts.mockImplementation((text) => [{ text }]);
    mocks.buildSessionContext.mockImplementation(({ requestMessages }) => ({
      messages: requestMessages,
      totalStoredMessages: requestMessages.length,
      memoryUsed: false,
      memoryRefreshed: false,
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

  it('records and returns a blocked stream without calling an AI provider', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      remaining: 41,
    });
    expect(mocks.createJsonLineStream).not.toHaveBeenCalled();
    expect(mocks.generateCoachingText).not.toHaveBeenCalled();
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
      headers: { 'Content-Type': 'application/json' },
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
    expect(mocks.usageInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allowed',
        category: 'coaching',
        provider_requested: true,
      })
    );
  });

  it('accepts an explicit null diagnosis code for legacy sessions', async () => {
    const request = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
