import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'success' as 'success' | 'error' | 'partial-error',
  releaseSecondChunk: (() => undefined) as () => void,
  secondChunkGate: Promise.resolve(),
  externalCalls: 0,
  externalMode: 'success' as 'success' | 'race' | 'all-error',
  externalProviders: [] as string[],
  externalTimeouts: [] as number[],
  externalImageCounts: [] as number[],
  openAIAborted: false,
  alerts: [] as Array<{ subject: string; summary: string }>,
}));

vi.mock('@/lib/openai', () => ({
  getGenAI: () => ({
    getGenerativeModel: () => ({
      startChat: () => ({
        sendMessageStream: async () => {
          if (state.mode === 'error') throw new Error('fetch failed');
          return {
            stream: (async function* () {
              yield { text: () => '最初の文です。' };
              await state.secondChunkGate;
              if (state.mode === 'partial-error') {
                throw new Error('connection reset');
              }
              yield { text: () => '次に進む質問ですか？' };
            })(),
            response: Promise.resolve({
              candidates: [{ finishReason: 'STOP' }],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 8,
                totalTokenCount: 18,
              },
            }),
          };
        },
      }),
    }),
  }),
}));

vi.mock('@/lib/coaching-provider-candidates', () => ({
  generateCoachingProviderCandidate: async (params: {
    provider: string;
    signal?: AbortSignal;
    timeoutMs: number;
    images?: unknown[];
  }) => {
    state.externalCalls += 1;
    state.externalProviders.push(params.provider);
    state.externalTimeouts.push(params.timeoutMs);
    state.externalImageCounts.push(params.images?.length || 0);
    if (state.externalMode === 'all-error') {
      throw new Error(`${params.provider} failed`);
    }
    if (state.externalMode === 'race' && params.provider === 'openai') {
      return new Promise((_, reject) => {
        params.signal?.addEventListener('abort', () => {
          state.openAIAborted = true;
          reject(new Error('OPENAI_ABORTED'));
        });
      });
    }
    if (state.externalMode === 'race') {
      return {
        rawText: '悔しさを踏まえました。明日まず何から始めますか？',
        firstChunkMs: 4,
        totalMs: 15,
        complete: true,
        finishReason: 'end_turn',
        usage: { prompt_tokens: 14, completion_tokens: 9, total_tokens: 23 },
      };
    }
    return {
      rawText: '失敗した処理を引き継ぎました。今いちばん確認したいことは何ですか？',
      firstChunkMs: 5,
      totalMs: 20,
      complete: true,
      finishReason: 'completed',
      usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
    };
  },
}));

vi.mock('@/lib/coaching-alerts', () => ({
  sendCoachingAlert: async (params: { subject: string; summary: string }) => {
    state.alerts.push(params);
    return { accepted: true, status: 200, id: 'test-alert' };
  },
}));

import { createJsonLineStream } from '../src/lib/coaching-gemini';

const decoder = new TextDecoder();
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  state.mode = 'success';
  state.externalCalls = 0;
  state.externalMode = 'success';
  state.externalProviders = [];
  state.externalTimeouts = [];
  state.externalImageCounts = [];
  state.openAIAborted = false;
  state.alerts = [];
  state.secondChunkGate = new Promise<void>((resolve) => {
    state.releaseSecondChunk = resolve;
  });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  state.releaseSecondChunk();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('createJsonLineStream', () => {
  it('生成途中の未検査文を送らず、最終検査後の本文だけを送る', async () => {
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事について相談したいです。' }],
      onDone: async () => ({ remaining: 49 }),
    });
    const reader = stream.getReader();

    let settledBeforeCompletion = false;
    const firstReadPromise = reader.read().then((result) => {
      settledBeforeCompletion = true;
      return result;
    });
    await Promise.resolve();
    expect(settledBeforeCompletion).toBe(false);

    state.releaseSecondChunk();
    const firstRead = await firstReadPromise;
    const firstEvent = JSON.parse(decoder.decode(firstRead.value).trim());
    expect(firstEvent).toMatchObject({ type: 'chunk', verified: true });
    const remaining = await readRemaining(reader);
    const events = remaining
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(events.some((event) => event.type === 'chunk')).toBe(false);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 49,
    });
  });

  it('Geminiが文章生成の途中で切れても未検査文を見せず予備AIへ切り替える', async () => {
    state.mode = 'partial-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事のことで迷っています。' }],
      onDone: async () => ({ remaining: 48 }),
      telemetry: {
        route: '/api/chat/test-provider-fallback',
        requestId: 'provider-fallback',
      },
    });
    const responsePromise = new Response(stream).text();
    state.releaseSecondChunk();
    const events = (await responsePromise)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const chunks = events.filter((event) => event.type === 'chunk');
    const done = events.find((event) => event.type === 'done');

    expect(state.externalCalls).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).not.toContain('最初の文です。');
    expect(done).toMatchObject({
      modelName: 'gpt-5.6-luna',
      provider: 'openai',
      fallbackFrom: 'gemini-3.5-flash',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 48,
    });
    expect(state.alerts).toHaveLength(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('Geminiが生成前に失敗した時はOpenAIで回答を完了する', async () => {
    state.mode = 'error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    state.releaseSecondChunk();

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事のことで迷っています。' }],
      onDone: async () => ({ remaining: 48 }),
    });
    const text = await new Response(stream).text();
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const chunk = events.find((event) => event.type === 'chunk');
    const done = events.find((event) => event.type === 'done');

    expect(state.externalCalls).toBe(1);
    expect(state.externalTimeouts).toEqual([10000]);
    expect(chunk).toMatchObject({ type: 'chunk', verified: true });
    expect(done).toMatchObject({
      modelName: 'gpt-5.6-luna',
      provider: 'openai',
      fallbackFrom: 'gemini-3.5-flash',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 48,
    });
  });

  it('画像付きフォールバックには画像処理用の15秒期限を使う', async () => {
    state.mode = 'error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    state.releaseSecondChunk();

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [
        { text: 'この画像を見てください。' },
        { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
      ],
      onDone: async () => ({ remaining: 47 }),
    });
    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(state.externalTimeouts).toEqual([15000]);
    expect(state.externalImageCounts).toEqual([1]);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      provider: 'openai',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
  });

  it('OpenAIが停止してもClaudeの回答を採用し、残った通信を止める', async () => {
    state.mode = 'error';
    state.externalMode = 'race';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    state.releaseSecondChunk();

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事のことで迷っています。' }],
      onDone: async () => ({ remaining: 47 }),
    });
    const text = await new Response(stream).text();
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(state.externalProviders.sort()).toEqual(['anthropic', 'openai']);
    expect(state.openAIAborted).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(done).toMatchObject({
      modelName: 'claude-sonnet-5',
      provider: 'anthropic',
      fallbackFrom: 'gemini-3.5-flash',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 47,
    });
  });

  it('3社とも失敗しても入力を失わずローカル応答を完了する', async () => {
    state.mode = 'error';
    state.externalMode = 'all-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    state.releaseSecondChunk();

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事がうまくいくか不安です。' }],
      onDone: async () => ({ remaining: 46 }),
      telemetry: {
        route: '/api/chat/test-local-fallback',
        requestId: 'local-fallback',
      },
    });
    const text = await new Response(stream).text();
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(state.externalCalls).toBe(2);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(done).toMatchObject({
      modelName: 'local-fallback',
      fallbackFrom: 'gemini-3.5-flash',
      completionStatus: 'fallback',
      finalizationStatus: 'complete',
      remaining: 46,
    });
    expect(done.message).toContain('不安');
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0].subject).toContain('応答失敗/中断');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"chat_stream_fallback_done"')
    );
  });
});

async function readRemaining(
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}
