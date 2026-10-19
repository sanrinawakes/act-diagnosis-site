import { describe, expect, it } from 'vitest';
import {
  COACHING_IMAGE_MODEL,
  COACHING_MAX_OUTPUT_TOKENS,
  COACHING_RESPONSE_SPEED_INSTRUCTION,
  COACHING_TEXT_MODEL,
  COACHING_TEXT_THINKING_LEVEL,
  assessCoachingResponseQuality,
  buildGeminiParts,
  buildUrgentSafetyResponse,
  classifyGeminiCompletion,
  containsInternalCoachingContextExposure,
  containsProtectedInternalContent,
  createJsonLineStream,
  generateCoachingText,
  getCoachingGeminiModelName,
  minimallySanitizeCoachingOutput,
  prepareGeminiHistory,
  prepareGeminiRequestHistory,
  stripInternalResponseStyleHint,
} from '../src/lib/coaching-gemini';
import {
  getCoachingSystemPrompt,
  getContextualizedPrompt,
} from '../src/data/coaching-system-prompt';
import { createCoachingSessionCorrelationId } from '../src/lib/coaching-telemetry';

// Synthetic conversations only. No production conversation text.

describe('getCoachingGeminiModelName', () => {
  it('通常会話は会話品質を優先した3.5 Flashを使う', () => {
    expect(COACHING_TEXT_MODEL).toBe('gemini-3.5-flash');
    expect(getCoachingGeminiModelName(buildGeminiParts('相談です。', []))).toBe(
      COACHING_TEXT_MODEL
    );
  });

  it('短い会話が内部思考だけで出力上限へ達しない設定にする', () => {
    expect(COACHING_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4096);
    expect(COACHING_TEXT_THINKING_LEVEL).toBe('low');
  });

  it('画像添付時も品質を優先した3.5 Flashを使う', () => {
    expect(COACHING_IMAGE_MODEL).toBe('gemini-3.5-flash');
    expect(
      getCoachingGeminiModelName(
        buildGeminiParts('この画像を見てください。', [
          {
            name: 'test.png',
            mimeType: 'image/png',
            data: 'aGVsbG8=',
          },
        ])
      )
    ).toBe(COACHING_IMAGE_MODEL);
  });
});

describe('coaching runtime prompt', () => {
  it('重複した長大な旧指示ではなく一貫した運用指示を使う', () => {
    const prompt = getCoachingSystemPrompt();

    expect(prompt.length).toBeLessThan(6000);
    expect(prompt).toContain('拒否された提案');
    expect(prompt).toContain('無理に付けない');
    expect(prompt).not.toContain('27タイプ');
  });

  it('新しい話題・一段ずつの深掘り・具体策要求を明示する', () => {
    const prompt = getCoachingSystemPrompt();

    expect(prompt).toContain('新しい話題を優先');
    expect(prompt).toContain('今の話と関係がある時だけ短く引用');
    expect(prompt).toContain('深掘りは一段ずつ行う');
    expect(prompt).toContain('具体策を求めた時は、質問だけで返さない');
    expect(prompt).toContain('最初の1〜2文では断定を避け');
    expect(COACHING_RESPONSE_SPEED_INSTRUCTION).toContain(
      '最初の1つを中心に、ただし本人の話の流れを切らない'
    );
  });

  it('診断情報は短い非表示文脈としてだけ追加する', () => {
    const prompt = getContextualizedPrompt('PGE-1');

    expect(prompt).toContain('非表示の参考情報');
    expect(prompt).toContain('安心や安全');
    expect(prompt.length).toBeLessThan(6500);
  });
});

describe('conversation continuity hints', () => {
  const history = [
    {
      role: 'assistant' as const,
      content: 'ご主人は、家賃を払わない理由について何と言っていますか？',
    },
  ];

  it('「何も言わない」の主語を直前の質問から引き継ぐ', () => {
    const parts = buildGeminiParts('何も言わない', [], history);
    const hint = parts
      .map((part) => ('text' in part ? part.text : ''))
      .join('\n');

    expect(hint).toContain('直前の質問で尋ねた相手や対象を主語として引き継ぐ');
    expect(stripInternalResponseStyleHint(hint)).toBe('何も言わない');
  });

  it('拒否された提案を言い換えて繰り返さない指示を加える', () => {
    const parts = buildGeminiParts('できない', [], [
      {
        role: 'assistant',
        content: 'もう一度ご主人へ伝えてみてください。',
      },
    ]);
    const hint = parts
      .map((part) => ('text' in part ? part.text : ''))
      .join('\n');

    expect(hint).toContain('否定した提案');
    expect(hint).toContain('人生全体の無気力や疲労へ意味を広げない');
  });

  it('提案後の「何も言わない」を提案実行済みとは決めつけない', () => {
    const parts = buildGeminiParts('何も言わない', [], [
      {
        role: 'assistant',
        content: '支払日と方法を事務的に確認してみてください。',
      },
    ]);
    const hint = parts
      .map((part) => ('text' in part ? part.text : ''))
      .join('\n');

    expect(hint).toContain('直前の提案を実行した結果へ勝手に変えない');
  });

  it('添付画像の事実確認では用途説明を挟まず直接答えるよう指示する', () => {
    const parts = buildGeminiParts(
      'この画像の色を一言で答えてください。',
      [
        {
          name: 'red.png',
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ],
      []
    );
    const hint = parts
      .map((part) => ('text' in part ? part.text : ''))
      .join('\n');

    expect(hint).toContain('添付画像を実際に確認');
    expect(hint).toContain('利用範囲の説明');
  });
});

describe('prepareGeminiHistory', () => {
  it('100件超の会話では直近20件を各2000文字まで保持する', () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as
        | 'user'
        | 'assistant',
      content: `${String(index + 1).padStart(3, '0')}:${'長'.repeat(2200)}`,
    }));

    const history = prepareGeminiHistory(messages);
    const texts = history.flatMap((item) =>
      item.parts.map((part) => part.text)
    );

    expect(texts.some((text) => text.startsWith('101:'))).toBe(true);
    expect(texts.some((text) => text.startsWith('120:'))).toBe(true);
    expect(texts.some((text) => text.startsWith('100:'))).toBe(false);
    const latest = texts.find((text) => text.startsWith('120:')) || '';
    expect(latest.length).toBeGreaterThan(2000);
    expect(latest).toContain('（長文のため一部省略）');
  });

  it('長い会話でも保存済み要約の初期事実を落とさない', () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          '以下は過去の会話の保存済み要約です。\n\n家賃は76000円で、夫は毎月20000円程度しか払っていない。',
      },
      {
        role: 'assistant' as const,
        content:
          '承知しました。保存済み要約を背景として踏まえ、直近の相談に自然に返答します。',
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: (index % 2 === 0 ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        content: `直近の会話${index + 1}`,
      })),
    ];

    const history = prepareGeminiHistory(messages);
    const text = history
      .flatMap((item) => item.parts.map((part) => part.text))
      .join('\n');

    expect(text).toContain('家賃は76000円');
    expect(text).toContain('夫は毎月20000円程度');
    expect(text).toContain('直近の会話20');
  });

  it('現在の画像の色・枚数・文字を尋ねる時は無関係な会話履歴を渡さない', () => {
    const history = prepareGeminiRequestHistory(
      [
        {
          role: 'user',
          content: '仕事を完璧にしようとして着手できません。',
        },
        {
          role: 'assistant',
          content: 'その仕事で外せない条件は何ですか？',
        },
      ],
      buildGeminiParts('この画像の色を一言で答えてください。', [
        {
          name: 'test.png',
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
    );

    expect(history).toEqual([]);
  });

  it('画像を使う通常相談では会話履歴を維持する', () => {
    const history = prepareGeminiRequestHistory(
      [
        {
          role: 'user',
          content: '職場で言われた言葉が気になっています。',
        },
      ],
      buildGeminiParts('このスクリーンショットも踏まえて相談したいです。', [
        {
          name: 'test.png',
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
    );

    expect(history.length).toBeGreaterThan(0);
    expect(
      history.flatMap((item) => item.parts.map((part) => part.text)).join('\n')
    ).toContain('職場で言われた言葉');
  });
});

describe('assessCoachingResponseQuality', () => {
  it('保存済み要約や内部メモの露出を検知する', () => {
    const exposed =
      '以下は過去の会話の保存済み要約です。\n前回までの保存済み要約: 夫との家計相談';

    expect(containsInternalCoachingContextExposure(exposed)).toBe(true);
    expect(assessCoachingResponseQuality(exposed).issues).toEqual([
      'internal_context_exposure',
    ]);
  });

  it('指示書の見出しや診断コードの露出も内部文脈の露出として検知する', () => {
    const exposed =
      '### セクション 2 の指示に従い、診断コード: SMA-3 として返答します。';

    expect(containsProtectedInternalContent(exposed)).toBe(true);
    expect(assessCoachingResponseQuality(exposed).issues).toEqual([
      'internal_context_exposure',
    ]);
  });

  it('一方的な生活費停止や口座名義の変更を高影響の未確認手続きとして検知する', () => {
    for (const text of [
      '1つ目は管理会社へ連絡して口座変更手続きを進めてください。2つ目は、家賃以外の生活費をすべてストップしてください。',
      '不足分を補填するのをやめ、家賃の引き落とし口座をご主人の名義に変更してください。管理会社へ連絡して手続きを進めましょう。',
    ]) {
      expect(assessCoachingResponseQuality(text).issues).toEqual([
        'unsafe_high_impact_advice',
      ]);
    }
  });

  it('合意なく家族の小遣いや共通口座を使う提案を検知し、合意を確認する提案は通す', () => {
    for (const text of [
      '夫が家事をしない場合は、家事代行の費用を夫の小遣いや共通口座から支払う形で進めてください。',
      '家事代行の費用を共通の生活費から支払うルールにしてください。',
      '家事代行の費用を家計から出してください。',
    ]) {
      expect(assessCoachingResponseQuality(text).issues).toContain(
        'unsafe_high_impact_advice'
      );
    }

    expect(
      assessCoachingResponseQuality(
        '家事代行の費用を共通の生活費から支払う場合は、負担額を二人で合意してから利用してください。'
      ).issues
    ).toEqual([]);
  });

  it('短い返答、定型の締め、話題の違いは安全系の判定にしない', () => {
    for (const text of [
      'どうしたいですか？',
      '今の話の中で、いちばん見過ごしたくない本音は何ですか？',
      '職場で評価を上げるには、上司へ進捗をこまめに共有し、次の会議で担当業務の成果を説明すると判断されやすくなります。',
    ]) {
      expect(assessCoachingResponseQuality(text).issues).toEqual([]);
    }
  });
});

describe('minimallySanitizeCoachingOutput', () => {
  it('コードフェンス、見出し記号、強調記号だけを外し、本文は書き換えない', () => {
    expect(
      minimallySanitizeCoachingOutput('```markdown\n## 見出し\n**本文です。**\n```')
    ).toBe('見出し\n本文です。');
    expect(minimallySanitizeCoachingOutput('どうしたいですか？')).toBe(
      'どうしたいですか？'
    );
  });
});

describe('createCoachingSessionCorrelationId', () => {
  it('会話相関IDは本文や生のsessionIdを含まず安定している', () => {
    const sessionId = 'a0db13fe-481d-4898-82e3-101f66dbd27f';
    const first = createCoachingSessionCorrelationId(sessionId);
    const second = createCoachingSessionCorrelationId(sessionId);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(first).not.toContain(sessionId);
    expect(createCoachingSessionCorrelationId(null)).toBeNull();
  });
});

describe('classifyGeminiCompletion', () => {
  it('STOPだけを正常完了として扱う', () => {
    expect(classifyGeminiCompletion('STOP')).toBe('complete');
    expect(classifyGeminiCompletion('MAX_TOKENS')).toBe('partial');
    expect(classifyGeminiCompletion('SAFETY')).toBe('partial');
    expect(classifyGeminiCompletion(undefined)).toBe('partial');
  });
});

describe('buildUrgentSafetyResponse', () => {
  it('自殺・自傷の危険がある相談では公的窓口と安全確保を優先する', () => {
    const result = buildUrgentSafetyResponse(
      'もう消えたいです。今から自分を傷つけるかもしれません。'
    );

    expect(result).toContain('一人にならず');
    expect(result).toContain('119');
    expect(result).toContain('0120-061-338');
    expect(result).toContain('0120-279-338');
    expect(result).toContain('24時間・無料');
    expect(result).not.toContain('タイプ');
  });

  it('非ストリーム経路ではGeminiを呼ばず安全応答を返す', async () => {
    const result = await generateCoachingText({
      systemPrompt: 'test',
      historyMessages: [],
      lastUserParts: [{ text: '自分を傷つけたいです。' }],
    });

    expect(result.modelName).toBe('local-safety');
    expect(result.completionStatus).toBe('complete');
    expect(result.finishReason).toBe('LOCAL_SAFETY_RESPONSE');
    expect(result.text).toContain('0120-061-338');
  });

  it('ストリーム経路でも安全応答と会話後処理を完了する', async () => {
    const stream = createJsonLineStream({
      systemPrompt: 'test',
      historyMessages: [],
      lastUserParts: [{ text: 'もう死にたいです。' }],
      onDone: async () => ({ remaining: 49 }),
    });
    const events = (await new Response(stream).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const chunk = events.find((event) => event.type === 'chunk');
    const done = events.find((event) => event.type === 'done');

    expect(chunk?.text).toContain('0120-279-338');
    expect(done).toMatchObject({
      modelName: 'local-safety',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      finishReason: 'LOCAL_SAFETY_RESPONSE',
      remaining: 49,
    });
  });

  it('身近な人の自殺相談にも安全案内を返す', () => {
    const result = buildUrgentSafetyResponse(
      '家族が死にたいと言っています。どうすればいいですか？'
    );

    expect(result).toContain('あなた自身または身近な方');
    expect(result).toContain('119');
  });

  it.each([
    '自殺しようと思っています。',
    '死んだ方がましです。',
    'もう生きられない。',
    '大量服薬を考えています。',
    'I want to kill myself.',
  ])('危険を示す言い換え「%s」を見落とさない', (message) => {
    expect(buildUrgentSafetyResponse(message)).toContain('119');
  });

  it.each([
    '仕事で失敗して落ち込んでいます。',
    '自殺予防についての資料を作っています。',
    '死にたくないので相談したいです。',
  ])('通常相談や話題説明「%s」には緊急案内を出さない', (message) => {
    expect(buildUrgentSafetyResponse(message)).toBeNull();
  });
});

