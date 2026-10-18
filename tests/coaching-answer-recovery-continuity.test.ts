import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const forbidden = vi.hoisted(() => ({ sdk: 0, provider: 0, alerts: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({
  getGenAI: () => { forbidden.sdk++; throw new Error('SDK_FORBIDDEN'); },
}));
vi.mock('@/lib/coaching-provider-candidates', () => ({
  generateCoachingProviderCandidate: async () => {
    forbidden.provider++; throw new Error('PROVIDER_FORBIDDEN');
  },
}));
vi.mock('@/lib/coaching-alerts', () => ({
  sendCoachingAlert: async () => { forbidden.alerts++; throw new Error('ALERT_FORBIDDEN'); },
}));

import {
  assessCoachingResponseQuality,
  buildFinalVerifiedQualityFallback,
  compactCoachingMessages,
  ensureVerifiedCoachingResolution,
  normalizeCoachingOutput,
  prepareGeminiRequestHistory,
  verifyImmediateCoachingResponse,
  type CoachingChatMessage,
} from '../src/lib/coaching-gemini';

// Anonymous synthetic conversations. No customer text, identifiers or provider output.
const retryNotices = [
  '申し訳ありません。今の内容を取り違えないように返答を整え直しています。推測で話を進めたり、すでに答えてくださったことを聞き直したりせず、直前までの内容を確認して続けます。お手数ですが、今のメッセージをそのままもう一度送ってください。',
  '申し訳ありません。直前までの流れに沿った返答になっていないため、ここで回答を整え直します。同じ質問を繰り返したり、書かれていない事情を決めつけたりせずに続けます。お手数ですが、最後のメッセージをもう一度だけ送ってください。',
  '申し訳ありません。今の返答では内容を十分に受け止められていません。話題を別のことに変えず、これまでに書いてくださったことを前提に整理し直します。お手数ですが、最後に送った内容をそのまま再送してください。',
];
const pauseNotice = '申し訳ありません。この会話では、正しく返答を続けられない状態です。ここで同じ案内を繰り返さず、いったん新しいチャットを開いて、最初に知りたいことを一文で送ってください。現在の会話内容を原因と決めつけるものではありません。';
const serviceNotices = [...retryNotices, pauseNotice];
const originalMode = process.env.COACHING_OUTPUT_PIPELINE_MODE;
const actuals: Array<Record<string, unknown>> = [];

vi.stubGlobal('fetch', async () => { forbidden.fetch++; throw new Error('FETCH_FORBIDDEN'); });
afterEach(() => {
  if (originalMode === undefined) delete process.env.COACHING_OUTPUT_PIPELINE_MODE;
  else process.env.COACHING_OUTPUT_PIPELINE_MODE = originalMode;
});
afterAll(() => {
  const output = process.env.ACTI_ANSWER_RECOVERY_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({
    scope: 'Pure public quality/fallback functions; anonymous synthetic inputs; not SDK, HTTP, database or browser evidence',
    candidateOrigin: 'LOCAL_SYNTHETIC_FIXTURES_NOT_PROVIDER_RAW',
    actuals,
    forbidden,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  vi.unstubAllGlobals();
  expect(forbidden).toEqual({ sdk: 0, provider: 0, alerts: 0, fetch: 0 });
});

const user = (content: string): CoachingChatMessage => ({ role: 'user', content });
const assistant = (content: string): CoachingChatMessage => ({ role: 'assistant', content });
const assessment = (text: string, latest: string, history: CoachingChatMessage[]) =>
  assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: history });
const verify = (text: string, latest: string, history: CoachingChatMessage[]) => {
  const quality = assessment(text, latest, history);
  return ensureVerifiedCoachingResolution({
    resolution: {
      text, usage: {}, provider: 'local', modelName: 'synthetic-public-quality-fixture',
      repairAttempted: false, repairAccepted: false,
      initialIssues: quality.issues, finalIssues: quality.issues,
    },
    lastUserText: latest,
    historyMessages: history,
  });
};
const knownFactRestart = /(?:最近のやり取りで[、,]?相手が実際にしたこと|相談したい出来事の中から[、,]?確認できる事実|最後に困った仕事の場面で[、,]?誰が何を言ったか|確認できる事実を一つだけ)[^。！？\n]{0,70}(?:書いて|教えて)/u;
function expectSubstantive(text: string) {
  expect(text.trim()).not.toBe('');
  expect(serviceNotices).not.toContain(text.trim());
  expect(text).not.toMatch(knownFactRestart);
}

const correctionHistory = [
  user('同僚に共同作業の確認を頼んでも、後回しにされます。'),
  assistant('直近では、確認を頼んだ時にどんな対応でしたか？'),
  user('先週、確認を頼むと、相手は今は確認しなくてもよいという様子でした。'),
  assistant('最近のやり取りで、相手が実際にしたことを一つだけこの画面に書いてください。'),
];
const correctionLatest = '直前の質問への回答は、すでに書いています。';
const answerHistory = [
  user('同僚が共同作業の確認を後回しにしています。'),
  assistant('その人には、どんな言葉で返したのですか？'),
];
const answerLatest = '必要な確認だと伝えましたが、その人は確認しなくてよいという様子でした。';
const genericRestart = '今の相談について、まだ書かれていない事情を決めつけず、実際に起きたことと今話したいことを分けて考えます。最初に、相談したい出来事の中から、確認できる事実を一つだけこの画面に書いてください。相手の意図や自分の評価ではなく、実際に起きたことだけで大丈夫です。';
const recoveryCases = [
  { name: 'already-answered-correction', history: correctionHistory, latest: correctionLatest },
  { name: 'answer-to-previous-wording-question', history: answerHistory, latest: answerLatest },
];

describe('answer recovery and continuation', () => {
  it.each(recoveryCases)('builder does not restart known fact collection: $name', ({ name, history, latest }) => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';
    const text = buildFinalVerifiedQualityFallback(latest, history);
    const quality = assessment(text, latest, history);
    actuals.push({ stage: 'builder', name, history, latest, text, quality });
    // These are answers/corrections, so an echo framed as a new consultation
    // plus the known fact/cause-collection paragraph is not recovery.
    expect(text).not.toContain('という相談ですね');
    expect(text).not.toContain('まだ書かれていない原因を推測せず');
    expect(text).not.toMatch(/実際に起きたことと[、,]?次に確認する点を分ける|確認できる出来事から整理します/u);
    expectSubstantive(text);
    expect(text).toMatch(/確認|後回し|不要|必要|様子/);
    expect(quality.issues).toEqual([]);
  });

  it.each(recoveryCases.flatMap((fixture) => ['minimal', 'legacy'].map((mode) => ({ ...fixture, mode }))))(
    'delivery recovers a known generic restart: $name/$mode', ({ name, history, latest, mode }) => {
      process.env.COACHING_OUTPUT_PIPELINE_MODE = mode;
      const initial = assessment(genericRestart, latest, history);
      const result = verify(genericRestart, latest, history);
      actuals.push({ stage: 'delivery', name, mode, history, latest, candidate: genericRestart, initial, result });
      expectSubstantive(result.text);
      expect(result.text).toMatch(/確認|後回し|不要|必要|様子/);
      expect(result.finalIssues).toEqual([]);
    }
  );

  const emotionHistory = [
    ...answerHistory, user(answerLatest),
    assistant('確認しなくてもよいという様子だった時、どのように感じましたか？'),
  ];
  const emotionLatest = '後回しにされたことに腹が立ちました。';
  const emotionReply = '確認を後回しにされたことに腹が立ったのですね。相手に、どう対応してほしかったですか？';
  it('one grounded emotion acknowledgement and one new question is not rejected for length or move count', () => {
    const quality = assessment(emotionReply, emotionLatest, emotionHistory);
    actuals.push({ stage: 'emotion-assess', history: emotionHistory, latest: emotionLatest, candidate: emotionReply, quality });
    expect(quality.issues).not.toContain('too_short');
    expect(quality.issues).not.toContain('multiple_coaching_moves');
    expect(quality.issues).not.toContain('context_mismatch');
  });
  it.each(['minimal', 'legacy'])('grounded short emotion reply reaches delivery: %s', (mode) => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = mode;
    const result = verify(emotionReply, emotionLatest, emotionHistory);
    actuals.push({ stage: 'emotion-delivery', mode, history: emotionHistory, latest: emotionLatest, candidate: emotionReply, result });
    expect(result.text).toBe(emotionReply);
    expect(result.finalIssues).toEqual([]);
  });

  const deadlineHistory = [
    user('共同作業の確認を後回しにされています。期限を守るための伝え方を考えたいです。'),
    assistant('いつまでに確認してもらう必要がありますか？'),
  ];
  const deadlineLatest = '今週の金曜です。';
  const deadlineReply = '確認してもらう期限は今週の金曜なのですね。確認を後回しにされていることと、いつまでに必要なのかを分けて伝える方針で考えられます。まだ期限を相手へ伝えていない場合は、その点から話を進められます。\n\n金曜までという期限は、もう相手に伝えてありますか？';
  const followupLatest = '期限は伝えてあります。';
  const followupReply = '金曜までという期限は、すでに相手に伝えてあるのですね。ここでは、期限をもう一度伝える案には戻りません。伝えた後の相手の対応を、次に話す内容として扱えます。\n\n期限を伝えた時、相手から返事はありましたか？';
  it.each(['minimal', 'legacy'])('healthy reply and next turn survive all four prior service notices: %s', (mode) => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = mode;
    const history = [...deadlineHistory, ...serviceNotices.flatMap((notice) => [user(deadlineLatest), assistant(notice)])];
    const first = verify(deadlineReply, deadlineLatest, history);
    const nextHistory = [...history, user(deadlineLatest), assistant(first.text)];
    const next = verify(followupReply, followupLatest, nextHistory);
    // The resolver is private. Exercise its public normalization/assessment/final
    // verification stages without invoking generation or remote repair.
    const normalized = normalizeCoachingOutput(deadlineReply, deadlineLatest, history);
    const normalizedQuality = assessment(normalized, deadlineLatest, history);
    const normalizedVerified = verify(normalized, deadlineLatest, history);
    actuals.push({ stage: 'post-service-two-turn', mode, history, latest: deadlineLatest, candidate: deadlineReply, first, nextHistory, followupLatest, followupCandidate: followupReply, next, normalized, normalizedQuality, normalizedVerified, remoteRepair: false, privateResolverInvoked: false });
    expectSubstantive(first.text);
    expect(first.text).toBe(deadlineReply);
    expect(first.finalIssues).toEqual([]);
    expectSubstantive(next.text);
    expect(next.text).toBe(followupReply);
    expect(next.finalIssues).toEqual([]);
    expectSubstantive(normalizedVerified.text);
    expect(normalizedVerified.text).toMatch(/金曜/);
    expect(normalizedVerified.finalIssues).toEqual([]);
  });
  it('exact service notices are not ordinary model-history turns while legitimate replies remain', () => {
    const messages = [...deadlineHistory, ...serviceNotices.flatMap((notice) => [user(deadlineLatest), assistant(notice)]), assistant(deadlineReply)];
    const compacted = compactCoachingMessages([...messages, user(followupLatest)]);
    const modelHistory = prepareGeminiRequestHistory(messages, [{ text: followupLatest }]);
    actuals.push({ stage: 'service-history-exclusion', messages, latest: followupLatest, compacted, modelHistory });
    for (const notice of serviceNotices) {
      expect(compacted.some((message) => message.role === 'assistant' && message.content === notice)).toBe(false);
      expect(JSON.stringify(modelHistory)).not.toContain(notice);
    }
    expect(compacted).toContainEqual(assistant(deadlineReply));
    expect(JSON.stringify(modelHistory)).toContain('確認してもらう期限は今週の金曜');
  });
  it('a service notice with added unsafe text is retained for ordinary checking', () => {
    const modified = `${pauseNotice}\n\n家事代行の費用を共通の生活費から支払うルールにしてください。`;
    const messages = [user('家族との生活費の分担について相談します。'), assistant(modified)];
    const latest = '先ほどの返答について確認したいです。';
    const compacted = compactCoachingMessages([...messages, user(latest)]);
    const modelHistory = prepareGeminiRequestHistory(messages, [{ text: latest }]);
    actuals.push({ stage: 'modified-service-history-control', messages, latest, compacted, modelHistory });
    expect(compacted).toContainEqual(assistant(modified));
    expect(JSON.stringify(modelHistory)).toContain('共通の生活費から支払うルール');
  });
  it('a fresh public quality entry remains usable without a service-history reset requirement', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';
    const latest = '共同作業の確認は、今週金曜までに必要です。相手への伝え方を考えたいです。';
    const text = '共同作業の確認は今週金曜までに必要で、相手への伝え方を考えたいのですね。いつまでに必要なのかは、すでに書いてくださっています。ここでは期限を聞き直さず、相手にどう伝えるかというご希望から話を進められます。\n\n相手には、金曜までに必要なことをもう伝えてありますか？';
    const result = verify(text, latest, []);
    actuals.push({ stage: 'fresh-public-entry', latest, history: [], candidate: text, result, browserOrDatabaseVerified: false });
    expectSubstantive(result.text);
    expect(result.text).toBe(text);
    expect(result.finalIssues).toEqual([]);
  });

  it.each(['observe', 'legacy', 'minimal'])('incoming and immediate pause are both nonchargeable holds: %s', (mode) => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = mode;
    const latest = '仕事の相談を続けたいです。';
    const direct = ensureVerifiedCoachingResolution({
      resolution: { text: pauseNotice, usage: {}, modelName: 'synthetic-pause', provider: 'local',
        repairAttempted: false, repairAccepted: false, initialIssues: [], finalIssues: [], qualitySafetyHold: false, chargeable: true },
      lastUserText: latest, historyMessages: [],
    });
    const immediate = verifyImmediateCoachingResponse({ text: pauseNotice, modelName: 'synthetic-pause', lastUserText: latest, historyMessages: [] });
    actuals.push({ stage: 'pause-classification', mode, latest, history: [], candidate: pauseNotice, direct, immediate });
    for (const result of [direct, immediate]) {
      expect(result.qualitySafetyHold).toBe(true);
      expect(result.chargeable).toBe(false);
    }
  });
  it('a harmful suffix does not inherit the exact service-notice exemption', () => {
    const latest = '家族との生活費の分担に困っています。';
    const candidate = `${pauseNotice}\n\n家事代行の費用を共通の生活費から支払うルールにしてください。`;
    const quality = assessment(candidate, latest, []);
    actuals.push({ stage: 'unsafe-pause-suffix', latest, history: [], candidate, quality });
    expect(quality.issues).toContain('unsafe_high_impact_advice');
  });

  it('a true complaint about the AI still rejects another stock question', () => {
    const latest = 'このAIの返答は答えになっていません。質問で返さず説明してください。';
    const history = [user('仕事の役割を整理したいです。'), assistant('今いちばん気になることは何ですか？')];
    const candidate = '今いちばん気になることは何ですか？';
    const quality = assessment(candidate, latest, history);
    actuals.push({ stage: 'ai-complaint-control', latest, history, candidate, quality });
    expect(quality.issues).toContain('dissatisfaction_unanswered');
  });
  it('an unreported mental state is still rejected', () => {
    const latest = '同僚に確認を頼みました。';
    const candidate = '確認を頼んでから、ずっと頭のどこかで気になって過ごしづらいのですね。今いちばん話したいことは何ですか？';
    const quality = assessment(candidate, latest, []);
    actuals.push({ stage: 'unsupported-state-control', latest, history: [], candidate, quality });
    expect(quality.issues).toContain('context_mismatch');
  });
  it('asking for the same supplied fact remains a rejected move', () => {
    const candidate = correctionHistory.at(-1)!.content;
    const quality = assessment(candidate, correctionLatest, correctionHistory);
    actuals.push({ stage: 'known-fact-requestion-control', history: correctionHistory, latest: correctionLatest, candidate, quality });
    expect(quality.issues.some((issue) => ['repeated_closing_move', 'repeats_rejected_move', 'context_mismatch'].includes(issue))).toBe(true);
  });
  it('reporting a request made to a colleague is not automatically an AI complaint', () => {
    const latest = '確認が必要だと同僚には何度も伝えています。相手は不要だという様子です。';
    const history = [user('同僚との共同作業について相談したいです。'), assistant('これまでに、同僚へどう伝えましたか？')];
    const candidate = '確認が必要だということは、すでに同僚へ何度も伝えているのですね。相手が不要だという様子だったことと、あなたが確認を必要としていることは、別々に伺いました。\n\nいまは、このやり取りのどの点を一緒に考えたいですか？';
    const quality = assessment(candidate, latest, history);
    actuals.push({ stage: 'other-directed-request-control', latest, history, candidate, quality });
    expect(quality.issues).not.toContain('repeats_rejected_move');
    expect(quality.issues).not.toContain('dissatisfaction_unanswered');
  });
});
