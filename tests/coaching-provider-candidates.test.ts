import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCoachingProviderCandidate } from '../src/lib/coaching-provider-candidates';

const encoder = new TextEncoder();

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('generateCoachingProviderCandidate', () => {
  it('OpenAIへ画像をdata URL形式で渡してstream完了を確認する', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: 'response.output_text.delta', delta: '画像を確認しました。' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
          },
        },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateCoachingProviderCandidate({
      provider: 'openai',
      model: 'gpt-test',
      systemPrompt: 'テスト指示',
      messages: [{ role: 'user', content: '画像を見てください。' }],
      images: [{ mimeType: 'image/png', data: 'YWJj' }],
      timeoutMs: 1000,
    });

    const body = parseRequestBody(fetchMock);
    const lastContent = body.input[0].content as Array<Record<string, string>>;
    expect(lastContent).toEqual([
      { type: 'input_text', text: '画像を見てください。' },
      { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
    ]);
    expect(result).toMatchObject({
      rawText: '画像を確認しました。',
      complete: true,
      finishReason: 'completed',
    });
  });

  it('Claudeへ画像をbase64 source形式で渡してstream完了を確認する', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        {
          type: 'message_start',
          message: { usage: { input_tokens: 15 } },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: '添付画像を確認しました。' },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 9 },
        },
        { type: 'message_stop' },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateCoachingProviderCandidate({
      provider: 'anthropic',
      model: 'claude-test',
      systemPrompt: 'テスト指示',
      messages: [{ role: 'user', content: '画像を見てください。' }],
      images: [{ mimeType: 'image/jpeg', data: 'ZGVm' }],
      timeoutMs: 1000,
    });

    const body = parseRequestBody(fetchMock);
    const lastContent = body.messages[0].content as Array<Record<string, unknown>>;
    expect(lastContent).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: 'ZGVm',
        },
      },
      { type: 'text', text: '画像を見てください。' },
    ]);
    expect(result).toMatchObject({
      rawText: '添付画像を確認しました。',
      complete: true,
      finishReason: 'end_turn',
      usage: { prompt_tokens: 15, completion_tokens: 9, total_tokens: 24 },
    });
  });

  it('外部AIが応答しない時は期限で通信をAbortする', async () => {
    const captured: { signal?: AbortSignal } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            captured.signal = init?.signal as AbortSignal;
            captured.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          })
      )
    );

    await expect(
      generateCoachingProviderCandidate({
        provider: 'openai',
        model: 'gpt-test',
        systemPrompt: 'テスト指示',
        messages: [{ role: 'user', content: '相談です。' }],
        timeoutMs: 20,
      })
    ).rejects.toThrow('OPENAI_TIMEOUT');
    expect(captured.signal?.aborted).toBe(true);
  });
});

function sseResponse(events: Array<Record<string, unknown>>) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function parseRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as {
    input: Array<{ content: unknown }>;
    messages: Array<{ content: unknown }>;
  };
}
