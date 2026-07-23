import { describe, expect, it, vi } from 'vitest';
import {
  connectChatWithRecovery,
  getUserFacingChatError,
} from '../src/lib/chat-request-client';

const requestBody = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  assistantMessageId: '33333333-3333-4333-8333-333333333333',
  messages: [{ role: 'user', content: '相談があります。' }],
  stream: true,
};

describe('connectChatWithRecovery', () => {
  it('retries a transient fetch failure with the exact same idempotency IDs', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response('ok', {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      );

    const result = await connectChatWithRecovery({
      body: requestBody,
      timeoutMs: 1000,
      timeoutMessage: 'timeout',
      retryDelaysMs: [0],
      fetchFn,
      delayFn: async () => {},
    });

    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchFn.mock.calls[1][1]?.body));
    expect(secondBody).toEqual(firstBody);
    expect(secondBody).toMatchObject({
      requestId: requestBody.requestId,
      assistantMessageId: requestBody.assistantMessageId,
    });
  });

  it('waits and retries when the server reports that the same response is still processing', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: '回答を処理中です。',
            code: 'CHAT_RESPONSE_PENDING',
          }),
          {
            status: 409,
            headers: {
              'Content-Type': 'application/json',
              'X-ACTI-Chat-Status': 'pending',
            },
          }
        )
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const result = await connectChatWithRecovery({
      body: requestBody,
      timeoutMs: 1000,
      timeoutMessage: 'timeout',
      retryDelaysMs: [0],
      fetchFn,
      delayFn: async () => {},
    });

    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(2);
  });

  it('does not retry an ordinary client error', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad request', { status: 400 }));

    const result = await connectChatWithRecovery({
      body: requestBody,
      timeoutMs: 1000,
      timeoutMessage: 'timeout',
      retryDelaysMs: [0, 0],
      fetchFn,
      delayFn: async () => {},
    });

    expect(result.response.status).toBe(400);
    expect(result.attempts).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('getUserFacingChatError', () => {
  it.each([
    new TypeError('Failed to fetch'),
    new TypeError('Load failed'),
    new Error('NetworkError when attempting to fetch resource.'),
  ])('converts browser network errors to clear Japanese guidance', (error) => {
    expect(getUserFacingChatError(error)).toBe(
      '通信が一時的に切れました。相談内容は保存されています。通信状態を確認して、もう一度送信してください。'
    );
  });
});
