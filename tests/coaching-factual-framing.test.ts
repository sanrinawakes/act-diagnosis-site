import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessCoachingResponseQuality,
  buildFinalVerifiedQualityFallback,
  ensureVerifiedCoachingResolution,
  normalizeCoachingOutput,
  type CoachingChatMessage,
} from '../src/lib/coaching-gemini';

afterEach(() => vi.unstubAllEnvs());
const correctionHistory: CoachingChatMessage[] = [
  { role: 'user', content: '研修で発表を終えました。' },
  { role: 'assistant', content: '発表についての相談ですね。困っていることを教えてください。' },
];
const paymentRequest = '家賃は82000円ですが、夫は毎月25000円くらいしか払わず、残りは私が負担しています。全額払ってほしいです。';
const ungroundedAgreement = '家賃の負担が偏っているのですね。ご主人は、決めた金額を支払わない理由を何と説明していますか？';

describe('factual correction and payment agreement grounding', () => {
  it.each(['相談ではない。', '相談ではありません。', '相談じゃない。'])('自発的な報告の訂正に質問への回答という経緯を足さない: %s', (lastUserText) => {
    const text = buildFinalVerifiedQualityFallback(lastUserText, correctionHistory);
    expect(text).not.toMatch(/質問への|質問に答え|問いへの答え|教えてください|[？?]/);
    expect(text).toMatch(/取り違え|決めつけ/);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: correctionHistory }).issues).toEqual([]);
  });

  it('訂正への候補に根拠のない質問回答の経緯があれば検出する', () => {
    expect(assessCoachingResponseQuality({
      text: 'こちらの質問へのお返事を、新しい相談として扱ってしまいました。すみません。今話してくださった内容は、質問に答えて伝えてくださった事実として理解しました。解決策を求める話だと決めつけずに伺います。',
      lastUserText: '相談ではない。', historyMessages: correctionHistory,
    }).issues).toContain('context_mismatch');
  });

  it('本人が質問への回答と明言していても余計な経緯を説明しない', () => {
    const lastUserText = '相談じゃなくて、聞かれたから答えただけです。';
    const text = buildFinalVerifiedQualityFallback(lastUserText, correctionHistory);
    expect(text).not.toMatch(/教えてください|書いてください|[？?]/);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: correctionHistory }).issues).toEqual([]);
  });

  it.each(['minimal', 'legacy'])('配信直前の訂正回復も事実だけを返す: %s', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const result = ensureVerifiedCoachingResolution({
      resolution: { text: '発表についての相談ですね。', usage: {}, modelName: 'synthetic',
        repairAttempted: false, repairAccepted: false, initialIssues: ['context_mismatch'], finalIssues: ['context_mismatch'] },
      lastUserText: '相談ではない。', historyMessages: correctionHistory,
    });
    expect(result.text).not.toMatch(/質問への|質問に答え|という相談/);
    expect(result.finalIssues).toEqual([]);
  });

  it.each(['minimal', 'legacy', 'observe'])('希望額から合意を前提にした候補を検出する: %s', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    expect(assessCoachingResponseQuality({ text: ungroundedAgreement, lastUserText: paymentRequest }).issues)
      .toContain('context_mismatch');
  });

  it.each(['半分を払ってほしい', '毎月40000円を払ってほしい'])('全額以外の支払希望も合意済みにはしない: %s', (request) => {
    expect(assessCoachingResponseQuality({ text: ungroundedAgreement,
      lastUserText: `家賃は82000円。夫には${request}と伝えていますが毎月25000円です。`,
    }).issues).toContain('context_mismatch');
  });

  it.each([
    '合意した負担が実行されていないことが問題です。支払記録を確認してください。',
    'ご主人が支払うと明確に了承した毎月の金額はいくらですか？',
  ])('相手の了承が未確認でも金額の合意を前提にしない: %s', (text) => {
    expect(assessCoachingResponseQuality({ text, lastUserText: paymentRequest }).issues).toContain('context_mismatch');
  });

  it.each(['負担額の合意はありません。', '負担額にはまだ合意していません。'])('合意の否定を根拠にしない: %s', (denial) => {
    expect(assessCoachingResponseQuality({ text: ungroundedAgreement,
      lastUserText: `${paymentRequest}${denial}` }).issues).toContain('context_mismatch');
  });

  it('以前のAIの合意推測を本人の合意の証拠にしない', () => {
    expect(assessCoachingResponseQuality({ text: ungroundedAgreement, lastUserText: '全額払ってほしいと伝えています。',
      historyMessages: [{ role: 'user', content: paymentRequest }, { role: 'assistant', content: '家賃は全額で合意したのですね。' }],
    }).issues).toContain('context_mismatch');
  });

  it('本人が合意を明言している時の金額確認は妨げない', () => {
    expect(assessCoachingResponseQuality({ text: ungroundedAgreement,
      lastUserText: '家賃は夫が全額負担すると二人で合意しました。それでも支払われません。',
    }).issues).not.toContain('context_mismatch');
  });

  it('同じ家賃について複数文で明示した合意額を不明へ戻さない', () => {
    const latest = '夫と家賃について話し合いました。毎月40000円で合意しました。全額払ってほしいですが、その合意額も払われません。';
    expect(assessCoachingResponseQuality({ text: ungroundedAgreement, lastUserText: latest }).issues).not.toContain('context_mismatch');
    const text = normalizeCoachingOutput('家賃について合意した金額が支払われていないのですね。ご主人は、その支払いについて何と説明していますか？', latest);
    expect(text).not.toMatch(/決めたことはありますか|合意[^。]{0,10}ありますか/);
  });

  it.each([
    '家賃を全額払うと合意しましたか？',
    '家賃の負担額について「二人で合意しました」と言うのはまだ事実ではありません。',
    '夫が「合意した」と言っていますが私は同意していません。',
    '姉は夫と家賃全額負担に合意しました。',
    '家賃は姉とその夫が全額負担で合意しました。',
    '子どもの送迎は二人で合意しました。',
    '以前の住居では家賃の全額負担に合意しました。',
    '友人は家賃を二人で合意しました。私たちには合意がありません。',
    '以前の家賃は二人で合意しました。話題を変えます。今の契約は私が全額を希望しているだけです。',
  ])('疑問、引用、第三者や旧話題の合意を現在の根拠にしない: %s', (context) => {
    expect(assessCoachingResponseQuality({ text: ungroundedAgreement,
      lastUserText: `${paymentRequest}${context}` }).issues).toContain('context_mismatch');
  });

  it.each([
    '合意した金額はまだありません。希望する負担額と実際の支払いは分けて確認できます。',
    '合意した金額がある場合は、その内容と実際の支払いを分けて確認できます。',
    'これまで二人で決めた金額はありますか？',
  ])('合意の不存在や条件付き説明は成立の断定にしない: %s', (text) => {
    expect(assessCoachingResponseQuality({ text: `家賃の分担について、${text}`, lastUserText: paymentRequest }).issues).not.toContain('context_mismatch');
  });

  it('合意の有無を尋ねる質問を合意の断定と区別する', () => {
    expect(assessCoachingResponseQuality({ text: '全額負担してほしいという希望と、相手が了承している内容は分けて確認できます。支払い分担について、これまで二人で決めたことはありますか？',
      lastUserText: paymentRequest,
    }).issues).not.toContain('context_mismatch');
  });

  it('払えないという未確認の能力推測を直す際も合意を作らない', () => {
    const text = normalizeCoachingOutput('ご主人は、家賃を全額払えない理由を何と説明していますか？', paymentRequest);
    expect(text).not.toMatch(/払えない|決めた金額|合意した|了承した/);
    expect(text).toMatch(/支払|負担/);
  });

  it('同じ依頼への別案でも成立済みの合意とは断定しない', () => {
    const text = normalizeCoachingOutput('同じお願いをもう一度してみてください。',
      '同じお願いはもう毎月しています。同じ提案はしないでください。',
      [{ role: 'user', content: paymentRequest }]);
    expect(text).not.toMatch(/合意した負担|決めた金額を支払わない/);
  });

  it('断る前の心配へ過去に断った実績や悪化を足さない', () => {
    const history: CoachingChatMessage[] = [
      { role: 'user', content: '友人からの誘いを断りたいのに、返事を遅らせています。' },
      { role: 'assistant', content: '返事を書こうとすると、何が気になりますか？' },
    ];
    const text = buildFinalVerifiedQualityFallback('断ると関係が悪くなる気がします。', history);
    expect(text).not.toMatch(/以前その友人|今回も|断る言葉が決ま/);
    expect(text).toMatch(/断った|断る/);
    expect(assessCoachingResponseQuality({ text, lastUserText: '断ると関係が悪くなる気がします。', historyMessages: history }).issues).toEqual([]);
  });

  it.each(['minimal', 'legacy'])('家事の気持ちの説明へ未提示の予定や時期を足さない: %s', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const history: CoachingChatMessage[] = [
      { role: 'user', content: '夫に家事を頼んでも後回しにされます。私ばかり負担している気がして腹が立ちます。' },
      { role: 'assistant', content: '最初に担当を固定してほしい家事は何ですか？' },
    ];
    const latest = '家事そのものより、私の時間を軽く扱われているように感じることが嫌なんです。';
    const text = normalizeCoachingOutput('家事の負担について話しているのですね。', latest, history);
    expect(text).not.toMatch(/対応時期が決まら|あなたの予定が後回し/);
    expect(text).toContain('時間を軽く扱われているように感じる');
    expect(assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: history }).issues).toEqual([]);
  });

  it('記録済みの支払状況から別案へ進む時に古い例の金額を流用しない', () => {
    const text = normalizeCoachingOutput('同じお願いをもう一度伝えてください。',
      'その方法はもう試しました。質問を返さず、今までと違う対応を具体的に答えてください。',
      [{ role: 'user', content: paymentRequest },
        { role: 'assistant', content: 'まず直近3か月の家賃額、相手の支払額、不足額を記録してください。' }]);
    expect(text).not.toMatch(/76,000|76000/);
    expect(text).toMatch(/負担額|支払/);
  });

  it('妻との会話への訂正を彼や未提示の恋愛文へ置き換えない', () => {
    const text = buildFinalVerifiedQualityFallback('質問に答えただけです。', [
      { role: 'user', content: '妻への返事を考えていました。' },
      { role: 'assistant', content: '妻との会話では何について話していましたか？' },
    ]);
    expect(text).not.toMatch(/彼|大好き|告白/);
  });

  it('断り文に本人が述べていない業務予定や多忙を足さない', () => {
    const latest = '仕事で依頼を断れず悩んでいます。明日断る一言を一つだけ教えてください。';
    const text = normalizeCoachingOutput('「あいにく本日の業務予定が埋まっておりまして、今回はお引き受けできません。」', latest);
    expect(text).toContain('今回はお引き受けできません');
    expect(text).not.toMatch(/予定が埋|手一杯|手がいっぱい|本日/);
    expect(assessCoachingResponseQuality({ text: '「本日の業務予定が埋まっているため、今回はお引き受けできません。」', lastUserText: latest }).issues).toContain('context_mismatch');
  });

  it('本人が明示した多忙を断り文から削除しない', () => {
    const latest = '今は手一杯です。仕事の依頼を断る一言を一つだけ教えてください。';
    const text = normalizeCoachingOutput('「ありがとうございます。ただ、今は手一杯のため、今回はお引き受けできません。」', latest);
    expect(text).toContain('手一杯');
    expect(assessCoachingResponseQuality({ text, lastUserText: latest }).issues).not.toContain('context_mismatch');
  });

  it('本人が明示した別の理由を含む自然な断り文を保持する', () => {
    const latest = '家族の予定があります。仕事の依頼を断る一言を一つだけ教えてください。';
    const draft = '「ありがとうございます。家族の予定があるため、今回はお引き受けできません。」';
    expect(normalizeCoachingOutput(draft, latest)).toBe(draft);
  });

  it.each([
    '今は手一杯ではありません。',
    '仕事の話は手一杯でした。話題を変えます。別の依頼の話です。',
  ])('多忙の否定や旧話題を断りの理由に再利用しない: %s', (context) => {
    const latest = `${context}仕事の依頼を断る一言を一つだけ教えてください。`;
    const text = normalizeCoachingOutput('「今は手一杯のため、今回はお引き受けできません。」', latest);
    expect(text).toBe('「ありがとうございます。今回はお引き受けできません。」');
  });

  it.each([
    '同僚は手一杯だそうですが、私は余裕があります。',
    '友人は手一杯だそうです。私は今回は気が進みません。',
    '以前は手一杯でしたが、今は余裕があります。',
    '「今は手一杯」とは言いたくありません。実際には余裕があります。',
  ])('第三者、過去や拒否した引用を本人の理由にしない: %s', (context) => {
    const latest = `${context}仕事の依頼を断る一言を一つだけ教えてください。`;
    const candidate = '「今は手一杯のため、今回はお引き受けできません。」';
    expect(assessCoachingResponseQuality({ text: candidate, lastUserText: latest }).issues).toContain('context_mismatch');
    expect(normalizeCoachingOutput(candidate, latest)).toBe('「ありがとうございます。今回はお引き受けできません。」');
    expect(buildFinalVerifiedQualityFallback(latest, [])).toBe('「ありがとうございます。今回はお引き受けできません。」');
  });

  it.each(['minimal', 'legacy', 'observe'])('同じ話題で最新の否定が以前の多忙説明を取り消す: %s', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const history: CoachingChatMessage[] = [
      { role: 'user', content: '今は手一杯です。' },
      { role: 'assistant', content: '依頼への返答を考えたいのですね。' },
    ];
    const latest = 'もう手一杯ではありません、仕事の依頼を断る一言を一つだけ教えてください。';
    const candidate = '「今は手一杯のため、今回はお引き受けできません。」';
    expect(assessCoachingResponseQuality({ text: candidate, lastUserText: latest, historyMessages: history }).issues).toContain('context_mismatch');
    expect(normalizeCoachingOutput(candidate, latest, history)).toBe('「ありがとうございます。今回はお引き受けできません。」');
    expect(buildFinalVerifiedQualityFallback(latest, history)).toBe('「ありがとうございます。今回はお引き受けできません。」');
  });

  it.each(['minimal', 'legacy', 'observe'])('最新の明示的な多忙説明は以前の否定より優先する: %s', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const history: CoachingChatMessage[] = [{ role: 'user', content: '今は手一杯ではありません。' }];
    const latest = '今は手一杯です。仕事の依頼を断る一言を一つだけ教えてください。';
    const candidate = '「ありがとうございます。ただ、今は手一杯のため、今回はお引き受けできません。」';
    expect(assessCoachingResponseQuality({ text: candidate, lastUserText: latest, historyMessages: history }).issues).not.toContain('context_mismatch');
    expect(normalizeCoachingOutput(candidate, latest, history)).toBe(candidate);
  });

  it.each(['minimal', 'legacy', 'observe'])('引用符なしの発言否定を本人の多忙説明としない: %s', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const latest = '手一杯だとは言っていません。仕事を断る一言を一つだけ教えてください。';
    const candidate = '「ありがとうございます。ただ、今は手一杯のため、今回はお引き受けできません。」';
    expect(assessCoachingResponseQuality({ text: candidate, lastUserText: latest }).issues).toContain('context_mismatch');
    expect(normalizeCoachingOutput(candidate, latest)).toBe('「ありがとうございます。今回はお引き受けできません。」');
  });

  it('直述終端の「だ」は明示された本人の事情として保持する', () => {
    const latest = '今は手一杯だ。仕事を断る一言を一つだけ教えてください。';
    const candidate = '「ありがとうございます。ただ、今は手一杯のため、今回はお引き受けできません。」';
    expect(assessCoachingResponseQuality({ text: candidate, lastUserText: latest }).issues).not.toContain('context_mismatch');
    expect(normalizeCoachingOutput(candidate, latest)).toBe(candidate);
  });

  const capacityForms = [
    ['手一杯です', '今は手一杯です。', '手一杯ですとは言っていません。', '今は手一杯のため'],
    ['手一杯だ', '今は手一杯だ。', '手一杯だとは言っていない。', '今は手一杯のため'],
    ['手一杯なので', '今は手一杯なので、今回は断りたいです。', '手一杯なのでという意味ではない。', '今は手一杯のため'],
    ['手一杯のため', '今は手一杯のため、今回は断りたいです。', '手一杯のためとは言っていません。', '今は手一杯のため'],
    ['手がいっぱい', '今は手がいっぱいです。', '手がいっぱいだとは言っていません。', '今は手がいっぱいのため'],
    ['手が一杯', '今は手が一杯です。', '手が一杯という意味ではない。', '今は手が一杯のため'],
    ['予定が埋まっています', '予定が埋まっています。', '予定が埋まっていますとは言っていません。', '予定が埋まっているため'],
    ['予定が埋まっている', '予定が埋まっているので、今回は断りたいです。', '予定が埋まっているという意味ではない。', '予定が埋まっているため'],
  ];

  it.each(capacityForms)('各多忙表現の発言否定が旧肯定を取消す: %s', (_name, positive, negative, reason) => {
    for (const mode of ['minimal', 'legacy', 'observe']) {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
      const history: CoachingChatMessage[] = [{ role: 'user', content: positive }];
      const latest = `${negative}仕事を断る一言を一つだけ教えてください。`;
      const draft = `「ありがとうございます。${reason}、今回はお引き受けできません。」`;
      expect(assessCoachingResponseQuality({ text: draft, lastUserText: latest, historyMessages: history }).issues).toContain('context_mismatch');
      expect(normalizeCoachingOutput(draft, latest, history)).toBe('「ありがとうございます。今回はお引き受けできません。」');
      expect(buildFinalVerifiedQualityFallback(latest, history)).toBe('「ありがとうございます。今回はお引き受けできません。」');
      for (const context of [`同僚は${positive}`, `「${positive}」とは言いたくありません。`, `以前は${positive}`]) {
        const unrelatedLatest = `${context}仕事を断る一言を一つだけ教えてください。`;
        expect(assessCoachingResponseQuality({ text: draft, lastUserText: unrelatedLatest }).issues).toContain('context_mismatch');
        expect(normalizeCoachingOutput(draft, unrelatedLatest)).toBe('「ありがとうございます。今回はお引き受けできません。」');
        expect(buildFinalVerifiedQualityFallback(unrelatedLatest, [])).toBe('「ありがとうございます。今回はお引き受けできません。」');
      }
    }
  });

  it.each(capacityForms)('各多忙表現の最新肯定は旧否定後も保持する: %s', (_name, positive, negative, reason) => {
    for (const mode of ['minimal', 'legacy', 'observe']) {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
      const history: CoachingChatMessage[] = [{ role: 'user', content: negative }];
      const latest = `${positive}仕事を断る一言を一つだけ教えてください。`;
      const draft = `「ありがとうございます。${reason}、今回はお引き受けできません。」`;
      expect(assessCoachingResponseQuality({ text: draft, lastUserText: latest, historyMessages: history }).issues).not.toContain('context_mismatch');
      expect(normalizeCoachingOutput(draft, latest, history)).toBe(draft);
    }
  });
});
