import { describe, expect, it, vi } from 'vitest';
import {
  connectChatWithRecovery,
  getUserFacingChatError,
  isRecoverableChatStreamError,
} from '../src/lib/chat-request-client';
import { ChatStreamReadError } from '../src/lib/chat-stream-client';

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

  it('keeps polling long enough for a replay that stays pending across several retries', async () => {
    const pendingResponse = () =>
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
      );
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const result = await connectChatWithRecovery({
      body: requestBody,
      timeoutMs: 1000,
      timeoutMessage: 'timeout',
      retryDelaysMs: [0, 0, 0, 0, 0],
      fetchFn,
      delayFn: async () => {},
    });

    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(4);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('retries a transient server error with the same idempotency IDs', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('temporarily unavailable', { status: 503 })
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
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][1]?.body).toBe(
      fetchFn.mock.calls[0][1]?.body
    );
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

  it('stops after the configured number of transient-network retries', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      connectChatWithRecovery({
        body: requestBody,
        timeoutMs: 1000,
        timeoutMessage: 'timeout',
        retryDelaysMs: [0, 0],
        fetchFn,
        delayFn: async () => {},
      })
    ).rejects.toThrow('Failed to fetch');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe('getUserFacingChatError', () => {
  it.each([
    'AIの応答が途中で切れました。入力内容は保存されています。もう一度お試しください。',
    'AIの応答データが途中で壊れました。入力内容は保存されています。もう一度お試しください。',
    'AIから空の応答が返されました。入力内容は保存されています。もう一度お試しください。',
  ])('shows fixed retry guidance for a known stream failure: %s', (message) => {
    expect(
      getUserFacingChatError(
        new ChatStreamReadError(message, {
          retryable: false,
          hadStreamData: true,
        })
      )
    ).toBe(message);
  });

  it.each([
    new TypeError('Failed to fetch'),
    new TypeError('Load failed'),
    new Error('NetworkError when attempting to fetch resource.'),
  ])('converts browser network errors to clear Japanese guidance', (error) => {
    expect(getUserFacingChatError(error)).toBe(
      '通信が一時的に切れました。通信状態を確認して、もう一度お試しください。'
    );
  });

  it('never shows unknown internal errors to a member', () => {
    expect(getUserFacingChatError(new Error('Invalid diagnosis code'))).toBe(
      '診断情報を確認できませんでした。画面を再読み込みして、もう一度お試しください。'
    );
    expect(getUserFacingChatError(new Error('SUPABASE_INTERNAL_DETAIL'))).toBe(
      'メッセージを送信できませんでした。画面を再読み込みして、もう一度お試しください。'
    );
    expect(
      getUserFacingChatError(
        new ChatStreamReadError('SUPABASE_INTERNAL_DETAIL', {
          retryable: false,
          hadStreamData: true,
        })
      )
    ).toBe(
      'メッセージを送信できませんでした。画面を再読み込みして、もう一度お試しください。'
    );
  });
});

describe('isRecoverableChatStreamError', () => {
  it.each([
    'AIから空の応答が返されました。入力内容は保存されています。もう一度お試しください。',
  ])('treats stream delivery failures as recoverable: %s', (message) => {
    expect(isRecoverableChatStreamError(new Error(message))).toBe(true);
  });

  it('retries only when the stream ended before any bytes arrived', () => {
    expect(
      isRecoverableChatStreamError(
        new ChatStreamReadError(
          'AIの応答が途中で切れました。入力内容は保存されています。もう一度お試しください。',
          { retryable: true, hadStreamData: false }
        )
      )
    ).toBe(true);
    expect(
      isRecoverableChatStreamError(
        new ChatStreamReadError(
          'AIの応答が途中で切れました。入力内容は保存されています。もう一度お試しください。',
          { retryable: false, hadStreamData: true }
        )
      )
    ).toBe(false);
  });

  it('does not retry a corrupted or partial stream that already returned bytes', () => {
    expect(
      isRecoverableChatStreamError(
        new ChatStreamReadError(
          'AIの応答データが途中で壊れました。入力内容は保存されています。もう一度お試しください。',
          { retryable: false, hadStreamData: true }
        )
      )
    ).toBe(false);
  });

  it('does not treat ordinary scope or auth errors as recoverable stream failures', () => {
    expect(
      isRecoverableChatStreamError(
        new Error('有料会員のみご利用いただけます。')
      )
    ).toBe(false);
  });
});
