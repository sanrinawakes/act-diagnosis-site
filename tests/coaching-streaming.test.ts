import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Synthetic conversations only. No production conversation text.
const state = vi.hoisted(() => ({
  mode: 'success' as
    | 'success'
    | 'error'
    | 'partial-error'
    | 'internal-context'
    | 'unsafe-advice'
    | 'non-stop'
    | 'non-stop-empty'
    | 'empty'
    | 'timeout',
  releaseSecondChunk: (() => undefined) as () => void,
  secondChunkGate: Promise.resolve(),
  modelCalls: 0,
  externalCalls: 0,
  externalMode: 'success' as
    | 'success'
    | 'race'
    | 'all-error'
    | 'internal-context',
  externalProviders: [] as string[],
  externalTimeouts: [] as number[],
  externalImageCounts: [] as number[],
  openAIAborted: false,
  alerts: [] as Array<{ subject: string; summary: string }>,
}));

const FIRST_CHUNK = '最初の文です。';
const SECOND_CHUNK = '次に進む質問ですか？';
const NONSTREAM_REPLY =
  '仕事のことで迷っているんですね。今いちばん気になっている出来事は何ですか？';
const LEAKED_REPLY =
  '以下は過去の会話の保存済み要約です。\n前回までの保存済み要約: 家計について相談していた。';
const UNSAFE_REPLY =
  '不足分を補填するのをやめ、家賃の引き落とし口座をご主人の名義に変更してください。管理会社へ連絡して手続きを進めましょう。';
const EXTERNAL_REPLY =
  '仕事のことで迷っているのですね。判断する前に確認したい事実と、すでに決まっている条件を分けて考えられます。\n\n仕事について、今決めたいことは何ですか？';
const UNAVAILABLE_NOTICE_PATTERN = /いま回答を作成できませんでした/;

function nonStreamText() {
  switch (state.mode) {
    case 'internal-context':
      return LEAKED_REPLY;
    case 'unsafe-advice':
      return UNSAFE_REPLY;
    case 'non-stop':
      return `${FIRST_CHUNK}${SECOND_CHUNK}`;
    case 'non-stop-empty':
    case 'empty':
      return '';
    default:
      return NONSTREAM_REPLY;
  }
}

function finishReason() {
  return state.mode === 'non-stop' || state.mode === 'non-stop-empty'
    ? 'MAX_TOKENS'
    : 'STOP';
}

vi.mock('@/lib/openai', () => ({
  getGenAI: () => ({
    getGenerativeModel: () => ({
      startChat: () => ({
        sendMessage: async () => {
          state.modelCalls += 1;
          if (state.mode === 'error') throw new Error('fetch failed');
          return {
            response: {
              text: () => nonStreamText(),
              candidates: [{ finishReason: finishReason() }],
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 30,
                totalTokenCount: 50,
              },
            },
          };
        },
        sendMessageStream: async () => {
          state.modelCalls += 1;
          if (state.mode === 'error') throw new Error('fetch failed');
          return {
            stream: (async function* () {
              yield {
                text: () =>
                  state.mode === 'internal-context'
                    ? '以下は過去の会話の保存済み要約です。\n'
                    : state.mode === 'unsafe-advice'
                      ? UNSAFE_REPLY
                      : FIRST_CHUNK,
              };
              await state.secondChunkGate;
              if (state.mode === 'partial-error') {
                throw new Error('connection reset');
              }
              if (state.mode === 'timeout') {
                throw new Error('GEMINI_TIMEOUT');
              }
              yield {
                text: () =>
                  state.mode === 'internal-context'
                    ? '前回までの保存済み要約: 家計について相談していた。'
                    : state.mode === 'unsafe-advice'
                      ? ''
                      : SECOND_CHUNK,
              };
            })(),
            response: Promise.resolve({
              candidates: [{ finishReason: finishReason() }],
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
    if (state.externalMode === 'internal-context') {
      return {
        rawText: LEAKED_REPLY,
        firstChunkMs: 5,
        totalMs: 20,
        complete: true,
        finishReason: 'completed',
        usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
      };
    }
    return {
      rawText: EXTERNAL_REPLY,
      firstChunkMs: 5,
      totalMs: 20,
      complete: true,
      finishReason: state.externalMode === 'race' ? 'end_turn' : 'completed',
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

import {
  createJsonLineStream,
  generateCoachingText,
  type CoachingChatMessage,
  type CoachingCompletionDetails,
} from '../src/lib/coaching-gemini';
import { DEFAULT_GEMINI_TEXT_TIMEOUT_MS } from '../src/lib/coaching-model-config';

const decoder = new TextDecoder();
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  state.mode = 'success';
  state.modelCalls = 0;
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

async function streamOnce(params: {
  lastUserText: string;
  historyMessages?: CoachingChatMessage[];
  parts?: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
  telemetryRoute?: string;
  release?: boolean;
}) {
  const completions: CoachingCompletionDetails[] = [];
  const stream = createJsonLineStream({
    systemPrompt: 'テスト用指示',
    historyMessages: params.historyMessages || [],
    lastUserParts: params.parts || [{ text: params.lastUserText }],
    onDone: async (_usage, completion) => {
      completions.push(completion);
      return { remaining: 48 };
    },
    telemetry: params.telemetryRoute
      ? {
          route: params.telemetryRoute,
          requestId: 'test',
          requestMessages: 1,
          compactMessages: 1,
          historyMessages: params.historyMessages?.length || 0,
          attachments: 0,
          lastUserChars: params.lastUserText.length,
        }
      : undefined,
  });
  if (params.release !== false) state.releaseSecondChunk();
  const events = (await new Response(stream).text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const done = events.find((event) => event.type === 'done');
  if (!done) throw new Error('stream did not emit a done event');
  const chunks = events
    .filter((event) => event.type === 'chunk')
    .map((event) => String(event.text));
  return { events, done, chunks, completion: completions[0] };
}

describe('createJsonLineStream', () => {
  it('ストリーミングのモデル初回トークン時間をttftMsとして記録する', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await streamOnce({
        lastUserText: '仕事について相談したいです。',
        telemetryRoute: '/api/chat/test-ttft',
      });

      const payloads = infoSpy.mock.calls
        .map(([message]) => {
          try {
            return JSON.parse(String(message));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const done = payloads.find(
        (payload) => payload.event === 'chat_stream_done'
      );
      expect(done.ttftMs).toEqual(expect.any(Number));
      expect(done.ttftMs).toBe(done.generationFirstChunkMs);
      expect(done).not.toHaveProperty('pipelineMode');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('モデルの本文をそのまま課金対象の回答として届ける', async () => {
    const { done, chunks, completion } = await streamOnce({
      lastUserText: '仕事について相談したいです。',
    });

    expect(chunks).toEqual([`${FIRST_CHUNK}${SECOND_CHUNK}`]);
    expect(done).toMatchObject({
      modelName: 'gemini-3.5-flash',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      finishReason: 'STOP',
      qualityInitialIssues: [],
      qualityFinalIssues: [],
      qualitySafetyHold: false,
      message: `${FIRST_CHUNK}${SECOND_CHUNK}`,
      remaining: 48,
    });
    expect(done.provider ?? 'gemini').toBe('gemini');
    expect(completion.chargeable).toBe(true);
    expect(state.alerts).toHaveLength(0);
  });

  it('正常なHTTP 200でも内部要約を表示せず固定の案内へ置き換える', async () => {
    state.mode = 'internal-context';
    const { done, chunks, completion } = await streamOnce({
      lastUserText: '上司との話し方に迷っています。',
      historyMessages: [
        { role: 'user', content: '今日は仕事の相談をしたいです。' },
      ],
    });

    expect(done.qualityInitialIssues).toContain('internal_context_exposure');
    expect(done.qualityFinalIssues).toEqual([]);
    expect(done.qualitySafetyHold).toBe(false);
    expect(done.modelName).toBe('local-output-safety-fallback');
    expect(done.provider).toBe('local');
    expect(String(done.message)).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
    expect(String(done.message)).toMatch(/公開できません/);
    expect(chunks.join('')).toBe(done.message);
    expect(completion.chargeable).toBe(false);
  });

  it('予備AIが内部要約を返しても同じ境界で遮断する', async () => {
    state.mode = 'error';
    state.externalMode = 'internal-context';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const { done, completion } = await streamOnce({
      lastUserText: '仕事の相談をしたいです。',
    });

    expect(done.qualityInitialIssues).toContain('internal_context_exposure');
    expect(done.qualityFinalIssues).toEqual([]);
    expect(done.provider).toBe('local');
    expect(String(done.message)).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
    expect(completion.chargeable).toBe(false);
  });

  it('生活への影響が大きい未確認の手続き提案は中立の案内に置き換え、課金しない', async () => {
    state.mode = 'unsafe-advice';
    const { done, chunks, completion } = await streamOnce({
      lastUserText: '今までと違う対応を具体的に答えてください。',
      historyMessages: [
        {
          role: 'user',
          content: '家賃は76000円なのに、夫は毎月20000円くらいしか払いません。',
        },
      ],
    });

    expect(done.qualityInitialIssues).toContain('unsafe_high_impact_advice');
    expect(done.qualityFinalIssues).toEqual([]);
    expect(done.modelName).toBe('local-output-safety-fallback');
    expect(done.provider).toBe('local');
    expect(String(done.message)).not.toMatch(/名義|管理会社/);
    expect(String(done.message)).toMatch(/お伝えするのを控えました/);
    expect(chunks.join('')).toBe(done.message);
    expect(completion.chargeable).toBe(false);
  });

  it('ブラウザ側の接続が切れても回答生成と会話後処理を最後まで続ける', async () => {
    const onDone = vi.fn().mockResolvedValue({ remaining: 49 });
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事について相談したいです。' }],
      onDone,
    });
    const reader = stream.getReader();

    const cancelPromise = reader.cancel('client disconnected');
    state.releaseSecondChunk();
    await cancelPromise;

    await vi.waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
      }),
      expect.objectContaining({
        message: `${FIRST_CHUNK}${SECOND_CHUNK}`,
        completionStatus: 'complete',
      })
    );
  });

  it('生成途中の未検査文を送らず、境界を確認した本文だけを一度に送る', async () => {
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
      qualityFinalIssues: [],
      remaining: 49,
    });
    expect(state.modelCalls).toBe(1);
  });

  it('非STOPで終わっても本文があれば、差し替えずに途中までの本文を届ける', async () => {
    state.mode = 'non-stop';
    const { done, chunks, completion } = await streamOnce({
      lastUserText: '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
    });

    expect(chunks).toHaveLength(1);
    expect(done).toMatchObject({
      modelName: 'gemini-3.5-flash',
      completionStatus: 'partial',
      finishReason: 'MAX_TOKENS',
      qualityFinalIssues: [],
      finalizationStatus: 'complete',
      message: `${FIRST_CHUNK}${SECOND_CHUNK}`,
      remaining: 48,
    });
    expect(done.provider ?? 'gemini').toBe('gemini');
    expect(completion.chargeable).toBe(true);
    expect(completion.completionStatus).toBe('partial');
  });

  it('タイムアウト時は途中までの本文に続き案内を添えて届け、再送案内は出さない', async () => {
    state.mode = 'timeout';
    const { done, completion } = await streamOnce({
      lastUserText: '仕事のことで迷っています。',
    });

    expect(done).toMatchObject({
      completionStatus: 'partial',
      modelName: 'gemini-3.5-flash',
      provider: 'gemini',
      qualityFinalIssues: [],
      finalizationStatus: 'complete',
      remaining: 48,
    });
    expect(String(done.message)).toContain(FIRST_CHUNK);
    expect(String(done.message)).toContain('「続き」と入力すると');
    expect(String(done.message)).not.toMatch(/送ってください|再送/);
    expect(completion.chargeable).toBe(true);
  });

  it('Geminiが文章生成の途中で切れても未検査文を見せず予備AIへ切り替える', async () => {
    state.mode = 'partial-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const { done, chunks } = await streamOnce({
      lastUserText: '仕事のことで迷っています。',
      telemetryRoute: '/api/chat/test-provider-fallback',
    });

    expect(state.externalCalls).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain(FIRST_CHUNK);
    expect(done).toMatchObject({
      modelName: 'gpt-5.6-luna',
      provider: 'openai',
      fallbackFrom: 'gemini-3.5-flash',
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      message: EXTERNAL_REPLY,
      remaining: 48,
    });
    expect(state.alerts).toHaveLength(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('Geminiが生成前に失敗した時はOpenAIで回答を完了する', async () => {
    state.mode = 'error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const { done, chunks, completion } = await streamOnce({
      lastUserText: '仕事のことで迷っています。',
    });

    expect(state.externalCalls).toBe(1);
    expect(state.externalTimeouts).toEqual([10000]);
    expect(chunks).toEqual([EXTERNAL_REPLY]);
    expect(done).toMatchObject({
      modelName: 'gpt-5.6-luna',
      provider: 'openai',
      fallbackFrom: 'gemini-3.5-flash',
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 48,
    });
    expect(completion.chargeable).toBe(true);
  });

  it('長い履歴ではGemini停止前に予備AIを待機させる', async () => {
    vi.useFakeTimers();
    process.env.OPENAI_API_KEY = 'test-openai-key';

    try {
      const stream = createJsonLineStream({
        systemPrompt: 'テスト用指示',
        historyMessages: Array.from({ length: 18 }, (_, index) => ({
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `長い履歴${index + 1}`,
        })),
        lastUserParts: [{ text: '仕事のことで迷っています。' }],
        onDone: async () => ({ remaining: 48 }),
      });
      const responsePromise = new Response(stream).text();

      await vi.advanceTimersByTimeAsync(249);
      expect(state.externalCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.externalCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(
        DEFAULT_GEMINI_TEXT_TIMEOUT_MS - 250
      );

      const events = (await responsePromise)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.find((event) => event.type === 'done')).toMatchObject({
        fallbackFrom: 'gemini-3.5-flash',
        completionStatus: 'complete',
        finalizationStatus: 'complete',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('画像付きフォールバックには画像処理用の15秒期限を使う', async () => {
    state.mode = 'error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const { done } = await streamOnce({
      lastUserText: 'この画像を見てください。',
      parts: [
        { text: 'この画像を見てください。' },
        { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
      ],
    });

    expect(state.externalTimeouts).toEqual([15000]);
    expect(state.externalImageCounts).toEqual([1]);
    expect(done).toMatchObject({
      provider: 'openai',
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
  });

  it('OpenAIが停止してもClaudeの回答を採用し、残った通信を止める', async () => {
    state.mode = 'error';
    state.externalMode = 'race';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const { events, done } = await streamOnce({
      lastUserText: '仕事のことで迷っています。',
    });

    expect(state.externalProviders.sort()).toEqual(['anthropic', 'openai']);
    expect(state.openAIAborted).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(done).toMatchObject({
      modelName: 'claude-sonnet-5',
      provider: 'anthropic',
      fallbackFrom: 'gemini-3.5-flash',
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 48,
    });
  });

  it('3社とも失敗したら定型のコーチング文ではなく、作成できなかった旨の案内だけを課金なしで返す', async () => {
    state.mode = 'error';
    state.externalMode = 'all-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const { events, done, chunks, completion } = await streamOnce({
      lastUserText: '仕事がうまくいくか不安です。',
      telemetryRoute: '/api/chat/test-local-fallback',
    });

    expect(state.externalCalls).toBe(2);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(done).toMatchObject({
      modelName: 'local-fallback',
      provider: 'local',
      fallbackFrom: 'gemini-3.5-flash',
      completionStatus: 'fallback',
      finishReason: 'LOCAL_FALLBACK',
      finalizationStatus: 'complete',
      qualityInitialIssues: [],
      qualityFinalIssues: [],
      remaining: 48,
    });
    expect(String(done.message)).toMatch(UNAVAILABLE_NOTICE_PATTERN);
    expect(String(done.message)).not.toContain('不安');
    expect(chunks.join('')).toBe(done.message);
    expect(completion.chargeable).toBe(false);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0].subject).toContain('応答失敗/中断');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"chat_stream_fallback_done"')
    );
  });
});

describe('generateCoachingText', () => {
  it('モデルの本文をそのまま課金対象の回答として返す', async () => {
    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事のことで迷っています。' }],
    });

    expect(result).toMatchObject({
      text: NONSTREAM_REPLY,
      modelName: 'gemini-3.5-flash',
      completionStatus: 'complete',
      finishReason: 'STOP',
      qualityInitialIssues: [],
      qualityFinalIssues: [],
      qualitySafetyHold: false,
      chargeable: true,
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    });
    expect(result.provider ?? 'gemini').toBe('gemini');
  });

  it('非STOPで終わっても本文があれば途中までの本文を partial として返す', async () => {
    state.mode = 'non-stop';
    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事のことで少し落ち込んでいます。' }],
    });

    expect(result).toMatchObject({
      text: `${FIRST_CHUNK}${SECOND_CHUNK}`,
      modelName: 'gemini-3.5-flash',
      completionStatus: 'partial',
      finishReason: 'MAX_TOKENS',
      qualityFinalIssues: [],
      chargeable: true,
    });
  });

  it('非STOPで本文がない時は、作成できなかった旨の案内だけを課金なしで返す', async () => {
    state.mode = 'non-stop-empty';
    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事のことで少し落ち込んでいます。' }],
    });

    expect(result).toMatchObject({
      modelName: 'local-fallback',
      provider: 'local',
      completionStatus: 'partial',
      finishReason: 'MAX_TOKENS',
      qualityInitialIssues: [],
      qualityFinalIssues: [],
      chargeable: false,
    });
    expect(result.text).toMatch(UNAVAILABLE_NOTICE_PATTERN);
  });

  it('STOPなのに本文が空ならエラーにして経路側で再試行させる', async () => {
    state.mode = 'empty';
    await expect(
      generateCoachingText({
        systemPrompt: 'テスト用指示',
        historyMessages: [],
        lastUserParts: [{ text: '仕事のことで迷っています。' }],
      })
    ).rejects.toThrow('GEMINI_EMPTY_RESPONSE');
  });

  it('内部要約の露出は固定の案内へ置き換え、課金しない', async () => {
    state.mode = 'internal-context';
    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '家計の相談を続けたいです。' }],
    });

    expect(result.text).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
    expect(result).toMatchObject({
      modelName: 'local-output-safety-fallback',
      provider: 'local',
      completionStatus: 'complete',
      qualityFinalIssues: [],
      chargeable: false,
    });
    expect(result.qualityInitialIssues).toContain('internal_context_exposure');
  });

  it('生活への影響が大きい未確認の手続き提案は中立の案内へ置き換える', async () => {
    state.mode = 'unsafe-advice';
    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '今までと違う対応を具体的に答えてください。' }],
    });

    expect(result.text).not.toMatch(/名義|管理会社/);
    expect(result.text).toMatch(/お伝えするのを控えました/);
    expect(result).toMatchObject({
      modelName: 'local-output-safety-fallback',
      provider: 'local',
      chargeable: false,
    });
    expect(result.qualityInitialIssues).toContain('unsafe_high_impact_advice');
  });

  it('Geminiが失敗した時は予備AIの回答を使う', async () => {
    state.mode = 'error';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事のことで迷っています。' }],
    });

    expect(result).toMatchObject({
      text: EXTERNAL_REPLY,
      modelName: 'claude-sonnet-5',
      provider: 'anthropic',
      completionStatus: 'complete',
      finishReason: 'completed',
      chargeable: true,
    });
  });

  it('Geminiと予備AIの両方が失敗したら、作成できなかった旨の案内だけを課金なしで返す', async () => {
    state.mode = 'error';
    state.externalMode = 'all-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事がうまくいくか不安です。' }],
    });

    expect(result).toMatchObject({
      modelName: 'local-fallback',
      provider: 'local',
      completionStatus: 'fallback',
      finishReason: 'fetch failed',
      chargeable: false,
    });
    expect(result.text).toMatch(UNAVAILABLE_NOTICE_PATTERN);
    expect(result.text).not.toContain('不安');
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
