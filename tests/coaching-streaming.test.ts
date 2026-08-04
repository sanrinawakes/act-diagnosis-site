import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'success' as
    | 'success'
    | 'error'
    | 'partial-error'
    | 'internal-context'
    | 'non-stop'
    | 'timeout',
  releaseSecondChunk: (() => undefined) as () => void,
  secondChunkGate: Promise.resolve(),
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
  qualityRepairCalls: 0,
  qualityRepairMode: 'long' as
    | 'long'
    | 'short'
    | 'still-short'
    | 'vague'
    | 'ambiguous-action'
    | 'categorization'
    | 'financial',
  alerts: [] as Array<{ subject: string; summary: string }>,
}));

vi.mock('@/lib/openai', () => ({
  getGenAI: () => ({
    getGenerativeModel: () => ({
      startChat: () => ({
        sendMessage: async () => {
          state.qualityRepairCalls += 1;
          return {
            response: {
              text: () =>
                state.qualityRepairMode === 'financial'
                  ? '家計簿を付けているなら、先月と今月の支出を同じ項目ごとに比べると原因を絞れます。赤字8,166円は収入と支出の差なので、固定費、食費、臨時支出のうち、前月との差が大きい項目から見ると確認しやすいです。\n\nまずは今月と先月の固定費、食費、臨時支出を同じ項目で並べ、各項目の差額を合計してください。合計が8,166円に近い項目が、今回の赤字の主な原因です。'
                  : state.qualityRepairMode === 'short'
                  ? '上司に否定されたように感じて、次の一言が怖いんですね。次に何を避けたいですか？'
                  : state.qualityRepairMode === 'still-short'
                    ? 'どうしたいですか？'
                  : state.qualityRepairMode === 'vague'
                    ? '仕事のことで落ち込んでいる時は、頭の中も複雑に絡まりやすくなりますよね。\n\nまずは絡まった糸を少しずつ解きほぐしていきましょう。\n\n明日ひとつだけ状況を動かすなら、何から始めますか？'
                    : state.qualityRepairMode === 'ambiguous-action'
                      ? '明日、仕事の人間関係を円滑にし、SNSへの抵抗感がある中でも無理なくできる最初の一歩として、まずは身近な対面でのコミュニケーションを小さく始めることが役立ちます。'
                    : state.qualityRepairMode === 'categorization'
                      ? '仕事の悩みは、業務量や人間関係などの「環境の要因」と、自分のスキルや判断などの「個人の要因」が混ざると複雑に見えがちです。これらを分けて捉え直すことで、次の行動が見えてきます。\n\n仕事のことで、今いちばん気になっている出来事は何ですか？'
                  : '仕事について迷っている状況を、短い相づちだけで終わらせずに整理します。まず、今決めなければならないことと、まだ保留にできることを分けると、次の判断が見えやすくなります。今日決める必要がある項目を一つだけ確認してください。',
              candidates: [
                {
                  finishReason:
                    state.mode === 'non-stop' ? 'MAX_TOKENS' : 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 30,
                totalTokenCount: 50,
              },
            },
          };
        },
        sendMessageStream: async () => {
          if (state.mode === 'error') throw new Error('fetch failed');
          return {
            stream: (async function* () {
              yield {
                text: () =>
                  state.mode === 'internal-context'
                    ? '以下は過去の会話の保存済み要約です。\n'
                    : state.qualityRepairMode === 'ambiguous-action'
                    ? '明日ひとつだけ状況を動かすなら、'
                    : '最初の文です。',
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
                    : state.qualityRepairMode === 'ambiguous-action'
                    ? '何から始めますか？'
                    : '次に進む質問ですか？',
              };
            })(),
            response: Promise.resolve({
              candidates: [
                {
                  finishReason:
                    state.mode === 'non-stop' ? 'MAX_TOKENS' : 'STOP',
                },
              ],
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
        rawText:
          '仕事のことで迷っているのですね。今は仕事全体の結論を急ぐより、今日決める必要があることと、まだ確認できていないことを分ける方が判断しやすくなります。\n\nいま判断するために、まだ確認できていない事実は何ですか？',
        firstChunkMs: 4,
        totalMs: 15,
        complete: true,
        finishReason: 'end_turn',
        usage: { prompt_tokens: 14, completion_tokens: 9, total_tokens: 23 },
      };
    }
    if (state.externalMode === 'internal-context') {
      return {
        rawText:
          '以下は過去の会話の保存済み要約です。\n前回までの保存済み要約: 支払い分担について相談していた。',
        firstChunkMs: 5,
        totalMs: 20,
        complete: true,
        finishReason: 'completed',
        usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
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

import {
  assessCoachingResponseQuality,
  createJsonLineStream,
  generateCoachingText,
} from '../src/lib/coaching-gemini';

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
  state.qualityRepairCalls = 0;
  state.qualityRepairMode = 'long';
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
  it('正常なHTTP 200でも内部要約を表示せず文脈に沿う安全な回答へ置き換える', async () => {
    state.mode = 'internal-context';
    state.releaseSecondChunk();
    const onDone = vi.fn().mockResolvedValue({ remaining: 49 });
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [
        { role: 'user', content: '今日は仕事の相談をしたいです。' },
      ],
      lastUserParts: [{ text: '上司との話し方に迷っています。' }],
      onDone,
    });
    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done.qualityInitialIssues).toContain('internal_context_exposure');
    expect(done.qualityFinalIssues).toEqual([]);
    expect(done.qualitySafetyHold).toBe(false);
    expect(done.modelName).toBe('local-internal-context-recovery');
    expect(done.message).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
    expect(
      events.filter((event) => event.type === 'chunk').map((event) => event.text).join('')
    ).toBe(done.message);
    expect(onDone).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        qualityInitialIssues: expect.arrayContaining([
          'internal_context_exposure',
        ]),
        qualityFinalIssues: [],
      })
    );
  });

  it('予備AIが内部要約を返しても同じ最終ゲートで遮断する', async () => {
    state.mode = 'error';
    state.externalMode = 'internal-context';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    state.releaseSecondChunk();
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: '仕事の相談をしたいです。' }],
      onDone: async () => ({ remaining: 49 }),
    });
    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done.qualityInitialIssues).toContain('internal_context_exposure');
    expect(done.qualityFinalIssues).toEqual([]);
    expect(done.message).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
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
        prompt_tokens: 30,
        completion_tokens: 38,
        total_tokens: 68,
      }),
      expect.objectContaining({
        message: expect.any(String),
        completionStatus: 'complete',
      })
    );
  });

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
      qualityRepairAttempted: true,
      qualityRepairAccepted: true,
      qualityFinalIssues: [],
      remaining: 49,
    });
    expect(state.qualityRepairCalls).toBe(1);
  });

  it('非ストリーム経路が非STOPで終わっても検証済みのローカル救済文を返す', async () => {
    state.mode = 'non-stop';

    const result = await generateCoachingText({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [
        {
          text:
            '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
        },
      ],
    });

    expect(result).toMatchObject({
      modelName: 'local-incomplete-recovery',
      provider: 'local',
      completionStatus: 'partial',
      finishReason: 'MAX_TOKENS',
      qualityFinalIssues: [],
    });
    expect(
      assessCoachingResponseQuality({
        text: result.text,
        lastUserText:
          '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
      }).issues
    ).toEqual([]);
  });

  it('ストリーム経路が非STOPで終わっても品質判定済みの本文だけを返す', async () => {
    state.mode = 'non-stop';
    const lastUserText =
      '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。';
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: lastUserText }],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const chunks = events.filter((event) => event.type === 'chunk');
    const done = events.find((event) => event.type === 'done');

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ verified: true });
    expect(done).toMatchObject({
      modelName: 'local-incomplete-recovery',
      provider: 'local',
      completionStatus: 'partial',
      finishReason: 'MAX_TOKENS',
      qualityFinalIssues: [],
      finalizationStatus: 'complete',
      remaining: 48,
    });
    expect(
      assessCoachingResponseQuality({
        text: done.message,
        lastUserText,
      }).issues
    ).toEqual([]);
  });

  it('タイムアウト案内を加えた後の最終本文も品質判定へ通す', async () => {
    state.mode = 'timeout';
    const lastUserText = '仕事のことで迷っています。';
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [{ text: lastUserText }],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      completionStatus: 'partial',
      qualityFinalIssues: [],
      finalizationStatus: 'complete',
      remaining: 48,
    });
    expect(done.message).toContain('「続き」と入力すると');
    expect(done.message).not.toContain('送ってください');
    expect(
      assessCoachingResponseQuality({
        text: done.message,
        lastUserText,
      }).issues
    ).toEqual([]);
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
        requestMessages: 1,
        compactMessages: 1,
        historyMessages: 0,
        attachments: 0,
        lastUserChars: 13,
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
      qualityFinalIssues: [],
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
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 48,
    });
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
      await vi.advanceTimersByTimeAsync(6250);

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

  it('長い履歴で明日の一行動だけを求められたら待たせず返す', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: Array.from({ length: 18 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `仕事とSNS発信についての長い履歴${index + 1}`,
      })),
      lastUserParts: [
        { text: '明日まず何をすればいいか、一つだけ短く教えてください。' },
      ],
      onDone: async () => ({ remaining: 48 }),
    });

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(state.externalCalls).toBe(0);
    expect(done).toMatchObject({
      modelName: 'local-long-history-action',
      finishReason: 'LOCAL_LONG_HISTORY_ACTION',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      message:
        '明日の朝、SNSで最初に伝えたい内容を一文だけメモに書いてください。',
    });
  });

  it('話題ずれを指摘されたら直近の相談へ即時に戻す', async () => {
    const repeated =
      '現在の支払い分担について、口頭のお願い以外に確認できる合意や記録はありますか？';
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [
        {
          role: 'user',
          content: '以前、夫が家賃を払わないことで困っていました。',
        },
        { role: 'assistant', content: repeated },
        {
          role: 'user',
          content:
            '今回は講座に申し込まなかった後悔と、スピリチュアルな学びにこれ以上お金を使いたくない疲れ、お金が入ってこない不安の話です。',
        },
        { role: 'assistant', content: repeated },
        { role: 'user', content: '支払い分担って何の話？' },
        { role: 'assistant', content: repeated },
        {
          role: 'user',
          content: 'なんで私ばっかりお金が入ってこないの、という話です。',
        },
        { role: 'assistant', content: repeated },
      ],
      lastUserParts: [{ text: '本当に何の話？' }],
      onDone: async () => ({ remaining: 48 }),
    });

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(state.externalCalls).toBe(0);
    expect(state.qualityRepairCalls).toBe(0);
    expect(done).toMatchObject({
      modelName: 'local-topic-recovery',
      finishReason: 'LOCAL_TOPIC_RECOVERY',
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(done.message).toContain('講座への申し込みを保留');
    expect(done.message).toContain('現在の収入源');
    expect(done.message).toContain('今月必要な金額');
    expect(done.message).not.toMatch(/支払い分担|不足額|支払日/);
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
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      remaining: 47,
    });
  });

  it('再編集後も短い回答なら、検証済みの具体文へ置き換えて品質フラグを残さない', async () => {
    state.qualityRepairMode = 'short';
    state.externalMode = 'all-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [
        {
          role: 'user',
          content:
            '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
        },
        {
          role: 'assistant',
          content:
            '仕事で落ち込んでいるんですね。今一番気になっている出来事は何ですか？',
        },
      ],
      lastUserParts: [
        {
          text: '上司に否定されたように感じて、次の一言が怖いです。',
        },
      ],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      qualityRepairAttempted: true,
      qualityRepairAccepted: true,
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(done.message).toContain('最初に見直す点を一つ');
    expect(done.message.length).toBeGreaterThanOrEqual(90);
  });

  it('再編集が曖昧な比喩と二重の働きかけを返しても最終表示へ通さない', async () => {
    state.qualityRepairMode = 'vague';
    state.externalMode = 'all-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [
        {
          text:
            '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
        },
      ],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      qualityRepairAttempted: true,
      qualityRepairAccepted: true,
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(done.message).not.toMatch(/絡まった糸|解きほぐ|頭の中.*複雑/);
    expect(done.message.length).toBeGreaterThanOrEqual(80);
  });

  it('仕事とSNSの長い履歴で曖昧な回答を具体的な一動作へ置き換える', async () => {
    state.qualityRepairMode = 'ambiguous-action';
    const historyMessages = Array.from({ length: 218 }, (_, index) => ({
      role: 'user' as const,
      content:
        `これは長い履歴テスト用のダミー文です ${index}。仕事の悩み、人間関係、SNSへの抵抗感、明日の一歩について相談しています。`.repeat(
          10
        ),
    }));
    const lastUserText =
      '明日まず何をすればいいか、一つだけ短く教えてください。';
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages,
      lastUserParts: [{ text: lastUserText }],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      qualityRepairAttempted: false,
      qualityRepairAccepted: false,
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(state.qualityRepairCalls).toBe(0);
    expect(done.message).toBe(
      '明日の朝、SNSで最初に伝えたい内容を一文だけメモに書いてください。'
    );
    expect(
      assessCoachingResponseQuality({
        text: done.message,
        lastUserText,
        historyMessages,
      }).issues
    ).toEqual([]);
  });

  it('品質フォールバックでも上司への具体的な確認文を一般化しない', async () => {
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [
        {
          role: 'user',
          content:
            '上司に否定されたように感じて、次の一言が怖いです。',
        },
        {
          role: 'assistant',
          content:
            '次に話す時は、「前回のご指摘について、最初に見直す点を一つだけ挙げてもらえますか」と伝えてください。',
        },
      ],
      lastUserParts: [
        {
          text:
            'では、明日まず何をすればいいか一つだけ教えてください。',
        },
      ],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done.qualityFinalIssues).toEqual([]);
    expect(done.message).toBe(
      '明日の朝、上司に「前回のご指摘について、最初に見直す点を一つだけ挙げてもらえますか」と確認してください。'
    );
    expect(done.message).not.toContain('相手に最初に伝える');
  });

  it('再編集が利用者未提示の原因分類を足しても最終表示へ通さない', async () => {
    state.qualityRepairMode = 'categorization';
    state.externalMode = 'all-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [],
      lastUserParts: [
        {
          text:
            '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
        },
      ],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      qualityRepairAttempted: true,
      qualityRepairAccepted: true,
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(done.message).toContain('落ち込むきっかけになった出来事');
    expect(done.message).not.toMatch(/環境の要因|個人の要因|分類/);
  });

  it('具体的な家計質問を汎用の短文へ置き換えず、品質不合格時だけ再編集する', async () => {
    state.qualityRepairMode = 'financial';

    const lastUserText =
      '8166円赤字だけど原因を探る方法は？家計簿もつけているけど';
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [
        {
          role: 'user',
          content:
            '先月の収支と今月の収支を比べて、赤字の原因を確認したいです。',
        },
        {
          role: 'assistant',
          content:
            '収入と支出を分け、前月との差額を確認すると原因を特定できます。',
        },
      ],
      lastUserParts: [{ text: lastUserText }],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(state.qualityRepairCalls).toBe(1);
    expect(done).toMatchObject({
      provider: 'gemini',
      qualityRepairAttempted: true,
      qualityRepairAccepted: true,
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(done.message).toContain('赤字8,166円');
    expect(done.message).toContain('固定費、食費、臨時支出');
    expect(done.message).not.toContain(
      'まだ書かれていない原因を推測せず'
    );
    expect(
      assessCoachingResponseQuality({
        text: done.message,
        lastUserText,
        historyMessages: [
          {
            role: 'user',
            content:
              '先月の収支と今月の収支を比べて、赤字の原因を確認したいです。',
          },
          {
            role: 'assistant',
            content:
              '収入と支出を分け、前月との差額を確認すると原因を特定できます。',
          },
        ],
      }).issues
    ).toEqual([]);
  });

  it('家計の再編集が不合格でも、無関係な用事ではなく家計に沿う救済文を返す', async () => {
    state.qualityRepairMode = 'short';

    const lastUserText =
      '8166円赤字だけど原因を探る方法は？家計簿もつけているけど';
    const historyMessages = [
      {
        role: 'user' as const,
        content:
          '先月の収支と今月の収支を比べて、赤字の原因を確認したいです。',
      },
      {
        role: 'assistant' as const,
        content:
          '収入と支出を分け、前月との差額を確認すると原因を特定できます。',
      },
    ];
    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages,
      lastUserParts: [{ text: lastUserText }],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(state.qualityRepairCalls).toBe(1);
    expect(done).toMatchObject({
      qualityRepairAttempted: true,
      qualityRepairAccepted: true,
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(done.message).toContain('8,166円の赤字');
    expect(done.message).toContain('固定費');
    expect(done.message).not.toMatch(/用事|上司|紙に書/);
    expect(
      assessCoachingResponseQuality({
        text: done.message,
        lastUserText,
        historyMessages,
      }).issues
    ).toEqual([]);
  });

  it('不良段落をすべて除去した後も、不満へ短い空疎な文を返さず最終ゲート内で完結させる', async () => {
    state.qualityRepairMode = 'categorization';
    state.externalMode = 'all-error';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    const stream = createJsonLineStream({
      systemPrompt: 'テスト用指示',
      historyMessages: [
        {
          role: 'user',
          content: '仕事のことで悩んでいます。',
        },
        {
          role: 'assistant',
          content: '今いちばん気になっていることは何ですか？',
        },
      ],
      lastUserParts: [
        {
          text:
            '前より回答が短くて何を言いたいのかわかりません。ちゃんと答えてください。',
        },
      ],
      onDone: async () => ({ remaining: 48 }),
    });
    state.releaseSecondChunk();

    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      modelName: 'gemini-3.5-flash',
      provider: 'gemini',
      qualityRepairAttempted: true,
      qualityRepairAccepted: true,
      qualityFinalIssues: [],
      completionStatus: 'complete',
      finalizationStatus: 'complete',
    });
    expect(state.externalCalls).toBe(0);
    expect(done.message.length).toBeGreaterThanOrEqual(80);
    expect(done.message).toContain('仕事のことで悩んでいます');
    expect(done.message).toContain('考え方を先に示します');
    expect(done.message).not.toMatch(/環境の要因|個人の要因|分類/);
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
        requestMessages: 1,
        compactMessages: 1,
        historyMessages: 0,
        attachments: 0,
        lastUserChars: 14,
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
      qualityFinalIssues: [],
      remaining: 46,
    });
    expect(done.message).toContain('不安');
    expect(done.message.length).toBeGreaterThanOrEqual(80);
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
