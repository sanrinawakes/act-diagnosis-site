import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import * as actionLanguage from '../src/lib/coaching-action-language.mjs';
import * as quotationLanguage from '../src/lib/coaching-quotation-language.mjs';
import * as emotionLanguage from '../src/lib/coaching-emotion-language.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';
const transport = vi.hoisted(() => ({ provider: 0, fetch: 0, alert: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => { transport.provider++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.provider++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alert++; throw new Error('ALERT_FORBIDDEN'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, normalizeCoachingOutput, ensureVerifiedCoachingResolution, buildGeminiParts, createJsonLineStream, type CoachingChatMessage } from '../src/lib/coaching-gemini';
import { getContextualizedPrompt } from '../src/data/coaching-system-prompt';

// Exact synthetic input and public final captured by the production smoke on 9b5c061.
const repeated = '現在の支払い分担について、口頭のお願い以外に確認できる合意や記録はありますか？';
const history: CoachingChatMessage[] = [
  { role: 'user', content: '以前、夫が家賃を払わないことで困っていました。' },
  { role: 'assistant', content: '支払額と期限を文面で確認してください。' },
  { role: 'user', content: '今回は講座に申し込まなかった後悔と、スピリチュアルな学びにこれ以上お金を使いたくない疲れ、お金が入ってこない不安の話です。' },
  { role: 'assistant', content: repeated },
  { role: 'user', content: '支払い分担って何の話？' },
  { role: 'assistant', content: repeated },
  { role: 'user', content: 'なんで私ばっかりお金が入ってこないの、という話です。' },
  { role: 'assistant', content: repeated },
];
const latest = '本当に何の話？';
const badFinal = '前の返答は今回とは違う話を混ぜていました。申し訳ありません。\n\n今の話は、講座に申し込まなかった後悔、これ以上スピリチュアルな学びにお金を使いたくない疲れ、お金が入ってこない不安についてです。講座へ申し込む判断と、現在の収入の問題を分けます。今日は講座への申し込みを保留にし、現在の収入源と今月必要な金額を確認してください。';
const replayed: unknown[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => {
  const output = process.env.ACTI_TOPIC_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ transport, cases: replayed }, null, 2), { flag: 'wx', mode: 0o600 });
});
function topicReplyIsOneAction(text: string) {
  expect(text).toContain('講座');
  expect(text).toContain('現在の収入源');
  expect(text).toContain('今月必要な金額');
  expect(text).toContain('確認してください');
  expect(text).not.toMatch(/申し込みを保留|支払い分担|不足額|支払日/);
  expect(assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: history }).issues).toEqual([]);
}
describe('topic recovery keeps the next action to one operation', () => {
  it('rejects the actual hold-then-review production final', () => {
    expect(assessCoachingResponseQuality({ text: badFinal, lastUserText: latest, historyMessages: history }).issues).toContain('multiple_coaching_moves');
  });
  it('offers one financial review without an enrollment decision', () => {
    const final = buildFinalVerifiedQualityFallback(latest, history);
    replayed.push({ id: 'actual-topic-fallback', history, latest, capturedBadFinal: badFinal, final });
    topicReplyIsOneAction(final);
  });
  it.each(['minimal', 'legacy', 'observe'])('emits one complete local recovery with no provider in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    vi.stubGlobal('fetch', async () => { transport.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
    const callbacks: { message?: string }[] = [];
    const stream = createJsonLineStream({ systemPrompt: getContextualizedPrompt('MME-3'), historyMessages: history,
      lastUserParts: buildGeminiParts(latest, [], []), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } });
    const reader = stream.getReader(); const decoder = new TextDecoder(); let body = '';
    while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value, { stream: true }); }
    body += decoder.decode();
    const events = body.trim().split('\n').map(line => JSON.parse(line));
    const dones = events.filter(event => event.type === 'done'); expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
    const done = dones[0];
    replayed.push({ id: 'actual-topic-stream', mode, history, latest, capturedBadFinal: badFinal, events, final: done.message, callback: callbacks[0] });
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
    expect(callbacks[0].message).toBe(done.message);
    expect(done.modelName).toBe('local-topic-recovery');
    expect(done.finishReason).toBe('LOCAL_TOPIC_RECOVERY');
    expect(done.completionStatus).toBe('complete'); expect(done.finalizationStatus).toBe('complete');
    topicReplyIsOneAction(done.message);
    expect(transport).toEqual({ provider: 0, fetch: 0, alert: 0 });
  });
});

const shortHistory = (text: string): CoachingChatMessage[] => [
  { role: 'user', content: text }, { role: 'assistant', content: '今できることを一つずつ考えられます。' },
];
const cases = [
  { id: 'cafe-user-facts', user: 'カフェの集客を増やしたいです。私にできるのは発信と宣伝、コンサートで話すことです。', required: /カフェ/, forbidden: /暗闇|平日は静か|味や香り/ },
  { id: 'sns-without-cafe', user: 'SNSの発信を増やしたいです。仕事の投稿内容について相談しています。', required: /SNS|投稿/, forbidden: /カフェ|暗闇|コンサート|味や香り/ },
  { id: 'different-lecture-amounts', user: '学びを続けたいですが、給料から使えるのは3000円で講座は8000円です。', required: /学び|講座/, forbidden: /1万円|1万5千円|1万6千円|すでに自分で分かって/ },
  { id: 'keywords-do-not-establish-feelings', user: '講座とスピリチュアルな学びについて話しています。お金が入ってこない原因を整理したいです。', required: /講座|収入/, forbidden: /後悔|疲れ|不安/ },
  { id: 'no-invented-past-trial', user: '仕事で上司の期待と自分の意見が合わないので相談しています。', required: /意見|見解/, forbidden: /すでに試した/ },
];
describe('adjacent dissatisfaction branches use stated facts', () => {
  it.each(cases)('$id', f => {
    const h = shortHistory(f.user); const last = '全然違う回答ですね。';
    const final = buildFinalVerifiedQualityFallback(last, h);
    replayed.push({ id: f.id, history: h, latest: last, final });
    expect(final).toMatch(f.required); expect(final).not.toMatch(f.forbidden);
    expect(assessCoachingResponseQuality({ text: final, lastUserText: last, historyMessages: h }).issues).toEqual([]);
  });
  it('records a repeated rent shortage without adding a later written demand', () => {
    const h = shortHistory('家賃は82000円ですが夫は毎月25000円しか払いません。全額を払ってほしいと毎月伝えています。');
    const last = 'その伝え方はもう毎月試しています。同じ提案はしないでください。';
    const final = buildFinalVerifiedQualityFallback(last, h);
    replayed.push({ id: 'rent-record-only', history: h, latest: last, final });
    expect(final).toMatch(/記録してください/); expect(final).not.toMatch(/回答を求め|書面で回答/);
  });
  it('does not add household selection, execution and a conditional spending decision', () => {
    const h: CoachingChatMessage[] = [
      { role: 'user', content: '夫に家事を頼んでも後回しにされ、結局いつも自分がやることになります。' },
      { role: 'assistant', content: '担当を決めて伝えてみてください。' },
      { role: 'user', content: '担当を決めてほしいとは何度も伝えましたが、返事だけで行動は変わりません。' },
    ];
    const last = '同じ質問や、もう試した伝え方は繰り返さず、次にどう対応すればいいか答えてください。';
    const final = buildFinalVerifiedQualityFallback(last, h);
    replayed.push({ id: 'household-one-operation', history: h, latest: last, final });
    expect(final).toContain('家事'); expect(final).not.toMatch(/選び、|合意してから|決めた分担/);
  });
});

const containsPreparation = actionLanguage.containsChainedPreparationInstructions;
describe('preparation detection is bounded to current instructed actions', () => {
  it.each([
    '申し込みを保留にし、収入源を確認してください。',
    '申し込みを保留にしてください。その後、収入源を確認してください。',
    '申し込みを保留にしてから、収入源を確認してください。',
    '支払額を記録してください。その記録を使い、書面で回答を求める方法があります。',
    '支払額を一覧にしてください。その一覧を使い、書面で合意を求める段階です。',
    '支払額を記録し、次の対応を決めてください。',
    '支払額を記録してください。必要なら書面で回答を求める方法があります。',
  ])('rejects two independently executable operations: %s', text => {
    expect(containsPreparation(text, latest)).toBe(true);
    expect(assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: history }).issues).toContain('multiple_coaching_moves');
  });
  it.each([
    '講座と収入の話を分けます。現在の収入源と今月必要な金額を確認してください。',
    '現在の収入源と今月必要な金額を確認してください。',
    '今月の支払額を記録してください。その記録が判断の材料になります。',
    '保留にしたのですね。現在の収入源を確認してください。',
    '支払額を記録しました。今後の対応を決めてください。',
    'その記録があれば、書面で回答を求める方法があります。',
    '「申し込みを保留にし、収入源を確認してください」とAIに言われました。',
    '原文は「引用『説明です。』申し込みを保留にし、収入源を確認してください。」です。',
    '申し込みを保留にし、収入源を確認してくださいとAIに言われました。',
    '申し込みを保留にし、収入源を確認してくださいとは頼んでいません。',
    '支払額を記録してください。その記録で書面で回答を求める方法がありますとは言っていません。',
  ])('keeps one action, quotation, report, denial or past action: %s', text => {
    expect(containsPreparation(text, latest)).toBe(false);
  });
  it('keeps a separate current instruction after a nested quotation', () => {
    expect(containsPreparation('原文は「引用『説明です。』」です。申し込みを保留にし、収入源を確認してください。', latest)).toBe(true);
  });
  it.each([
    '複数の手順を教えてください。',
    '記録と書面回答を求める手順を説明してください。',
  ])('allows an affirmative current sequence request: %s', request => {
    expect(containsPreparation(badFinal, request)).toBe(false);
  });
  it.each([
    '複数の手順を説明しないでください。',
    '「複数の手順を教えてください」とは頼んでいません。',
    '複数の手順を教えてください。やはり複数は不要です。',
    '複数の手順ではなく、一つだけ教えてください。',
    '複数の手順を教えてくださいと昔頼みました。',
  ])('does not waive the rule for a negated, quoted, revoked or past request: %s', request => {
    expect(containsPreparation(badFinal, request)).toBe(true);
  });
});

const evaluatorSource = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const population = evaluatorSource.slice(evaluatorSource.indexOf('const BASELINE_QUALITY_POPULATION ='), evaluatorSource.indexOf('const args ='));
const evaluation = evaluatorSource.slice(evaluatorSource.indexOf('function evaluateConversations('), evaluatorSource.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${population}\n${evaluation}\nevaluateConversations`, {
  ...actionLanguage, ...quotationLanguage, ...emotionLanguage, containsDeadlineOutcomeAssurance,
  seededContinuityScenarios, evaluateSeededContinuityResponse,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
const smokeSource = readFileSync(resolve(process.cwd(), 'scripts/smoke-coaching-chat.mjs'), 'utf8');
const smokeAssertions = smokeSource.slice(smokeSource.indexOf('function assertResults('), smokeSource.indexOf('async function cleanup('));
const smoke = vm.runInNewContext(`${smokeAssertions}\nassertResults`, { ...actionLanguage, ...quotationLanguage, expectedTextModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000 });
function result(message: string) {
  return { label: 'topic-drift-recovery', lastUserText: latest,
    currentUserTexts: [...history.filter(m => m.role === 'user').map(m => m.content), latest], userGrounding: {},
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP', expectedFinishReason: 'STOP', expectedModelName: '', requiredResponseFragments: [],
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityFinalIssues: [], message };
}
function preparationChecks(message: string) {
  const turn = { user: latest, label: 'topic-recovery-1', message, rawMessage: message,
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP',
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] };
  return evaluate([{ name: 'topic-recovery', seedHistory: history, turns: [turn] }]).checks.filter((c: { name: string }) => /保留や記録の準備/.test(c.name));
}
describe('real production assertions retain the one-operation rule', () => {
  it('rejects the actual hold plus check in real smoke assertions', () => {
    expect(() => smoke([result(badFinal)])).toThrow(/preparation followed by another instruction/);
  });
  it('rejects the actual hold plus check in the real evaluator', () => {
    expect(preparationChecks(badFinal)).toEqual([{ name: 'topic-recovery-1: 保留や記録の準備に別の動作を重ねない', passed: false }]);
  });
  it('keeps the corrected single check valid in both assertions', () => {
    const final = buildFinalVerifiedQualityFallback(latest, history);
    expect(() => smoke([result(final)])).not.toThrow();
    expect(preparationChecks(final)).toEqual([{ name: 'topic-recovery-1: 保留や記録の準備に別の動作を重ねない', passed: true }]);
  });
});

describe('compact concrete Japanese action forms remain usable', () => {
  it.each([
    { verb: '書いて', user: '初めてサービスを使う人向けの資料を作っています。一枚目は利用目的です。',
      text: '資料の一枚目は利用目的の説明に使う予定なのですね。初めて使う人にサービスで何ができるかが伝わる一文だけを書いてください。' },
    { verb: '並べて', user: '家計簿をつけていますが赤字の原因を知りたいです。',
      text: '家計の変化を考える時は、同じ項目同士の比較が材料になります。まず、先月と今月の収入、固定費、変動費などを同じ項目で並べてください。' },
    { verb: '申し込んで', user: '家賃の支払いについて同じ提案ばかりで困っています。',
      text: '当事者同士だけで話が進まない時は、第三者の支援について相談する方法もあります。家計や夫婦関係を扱う相談窓口へ、相談の予約を申し込んでください。' },
    { verb: '休んで', user: '休息について相談しています。',
      text: '休息を別の課題を進めるための手段として評価する必要はありません。今は新しい準備や課題を増やさず、今日はゆっくり休んでください。' },
  ])('does not reject a concrete $verb action just for its conjugation', f => {
    const h = shortHistory(f.user);
    const quality = assessCoachingResponseQuality({ text: f.text, lastUserText: 'どう対応すればいいですか。', historyMessages: h });
    replayed.push({ id: 'compact-' + f.verb, history: h, latest: 'どう対応すればいいですか。', candidate: f.text, quality });
    expect(f.text.length).toBeGreaterThanOrEqual(50); expect(f.text.length).toBeLessThan(150);
    expect(quality.issues).not.toContain('too_short');
    expect(quality.issues).not.toContain('vague_action_target');
  });
  it('still rejects a short abstract instruction to think', () => {
    const text = '仕事の優先順位のつけ方には、いくつかの考え方があります。自分が大切にしたいことについて、もう少し考えてください。';
    const quality = assessCoachingResponseQuality({ text, lastUserText: '仕事をどう進めればいいですか。', historyMessages: shortHistory('仕事の優先順位を考えています。') });
    expect(quality.issues).toContain('too_short');
  });
});

it('keeps a grounded fan clarification without inventing the recipient state', () => {
  const user = '言語化がまだできないのだけど。ある芸能人の方に、メールを送ったのはいいが、ファンという感覚で送ったのではなく、ＰＴＳＤを発症してるように見えたから寄り添いたかっただけだった。でも向こうは私はファンのつもりで発信に努めてる。なんかそこに思いの差を感じて、最近はメール送るのはやめた。今日はその人の誕生日だけど、おめでとうくらい伝えてもいいのかもしれないけど、何を言っていいか分からん。その人の出演したものが見れてるわけでもないし。ファンとは少し違う気持ちだったから。でも、向こうとしてはそんな存在は、あまり求めてないと思う。';
  const h = shortHistory(user); const last = 'どういうこと？';
  const final = buildFinalVerifiedQualityFallback(last, h);
  const quality = assessCoachingResponseQuality({ text: final, lastUserText: last, historyMessages: h });
  replayed.push({ id: 'fan-grounded-clarification', history: h, latest: last, final, quality });
  expect(quality.issues).toEqual([]);
  expect(final).toContain('ファンとは少し違う');
  expect(final).not.toMatch(/相手の発信はファン向け|苦しい|温度差の中で言葉が出/);
});

const finitePublicStageFixtures = {
  "4": {
    "group": 4,
    "family": "written_preparation_then_conditional_consultation",
    "targetOldReturnLines": [
      4498,
      8089,
      8696
    ],
    "sourceSeed": {
      "path": "tests/coaching-output.test.ts",
      "revision": "9b5c061c4dfd2bda8a5c90039df13b19884c2b7a",
      "sha256": "5664caff23f72f7fb3a4cedb4d70d2ce9ad9b099a23cc87fded7083f8707d552",
      "marker": "家賃相談で記録を提案した後は、口頭依頼から期限付き書面へ切り替える"
    },
    "expectedSemanticDraft": "希望する家賃負担額、支払日、回答期限を一通の文面にまとめてください。",
    "branchCoverage": "UNKNOWN_NOT_INSTRUMENTED",
    "modes": [
      "minimal"
    ],
    "runApplication": true,
    "latest": "わからないから聞いています。質問を返さず、今までと違う対応を具体的に答えてください。",
    "history": [
      {
        "role": "user",
        "content": "家賃は76000円ですが、夫は毎月20000円くらいしか払わず、私が不足分を負担しています。"
      },
      {
        "role": "assistant",
        "content": "直近3か月の家賃額、相手の支払額、不足額を記録にまとめてください。"
      },
      {
        "role": "user",
        "content": "同じ提案や同じ質問はしないでください。"
      }
    ],
    "candidate": "今の話の中で、いちばん見過ごしたくない本音は何ですか？",
    "candidateKind": "existing_unit_candidate_not_provider_original"
  },
  "9": {
    "group": 9,
    "family": "select_then_say",
    "targetOldReturnLines": [
      5757
    ],
    "sourceSeed": {
      "path": "tests/coaching-output.test.ts",
      "revision": "9b5c061c4dfd2bda8a5c90039df13b19884c2b7a",
      "sha256": "5664caff23f72f7fb3a4cedb4d70d2ce9ad9b099a23cc87fded7083f8707d552",
      "marker": "SMAをどう上げるかの質問を抽象論だけで終えない"
    },
    "expectedSemanticDraft": "その日の終わりに、いちばん迷った出来事で実際に選んだ行動を、一文だけ書いてください。",
    "branchCoverage": "UNKNOWN_NOT_INSTRUMENTED",
    "modes": [
      "minimal"
    ],
    "runApplication": true,
    "latest": "SMA1をSMA2にするには？",
    "history": [
      {
        "role": "user",
        "content": "私はSMA1と出たけれど、前はSMA2.5だった。どうして低くなったのか知りたい。"
      }
    ],
    "candidateKind": "current_public_builder_output"
  },
  "11": {
    "group": 11,
    "family": "confirm_then_organize",
    "targetOldReturnLines": [
      6021
    ],
    "sourceSeed": {
      "path": "tests/coaching-output.test.ts",
      "revision": "9b5c061c4dfd2bda8a5c90039df13b19884c2b7a",
      "sha256": "5664caff23f72f7fb3a4cedb4d70d2ce9ad9b099a23cc87fded7083f8707d552",
      "marker": "学校での約束案に短く引っかかった返答を引用だけで返さない"
    },
    "expectedSemanticDraft": "親子には「今後、叩く・蹴る・命令して手を出させることをしない」とだけ確認してください。",
    "branchCoverage": "UNKNOWN_NOT_INSTRUMENTED",
    "modes": [
      "minimal"
    ],
    "runApplication": true,
    "latest": "それは",
    "history": [
      {
        "role": "user",
        "content": "学校との話し合いのあとに、相手側へどんな約束を確認したらよいか考えています。"
      },
      {
        "role": "assistant",
        "content": "今後の生活で暴力や嫌がらせをしないことを紙に書いて署名してもらい、破った時の利用停止も明記してください。"
      }
    ],
    "candidateKind": "current_public_builder_output"
  }
} as const;
describe('finite public stage regressions found in the fixed twenty groups', () => {
  it('keeps the concrete written rent request out of a false short-response hold', () => {
    const f = finitePublicStageFixtures[4]; const history = f.history.map(message => ({ ...message })) as CoachingChatMessage[];
    const text = buildFinalVerifiedQualityFallback(f.latest, history);
    const quality = assessCoachingResponseQuality({ text, lastUserText: f.latest, historyMessages: history });
    replayed.push({ id: 'finite-rent-draft-compact', history, latest: f.latest, final: text, quality });
    expect(quality.issues).toEqual([]);
    const final = ensureVerifiedCoachingResolution({ resolution: { text, usage: {}, modelName: 'local-fixture', repairAttempted: false, repairAccepted: false, initialIssues: quality.issues, finalIssues: quality.issues }, lastUserText: f.latest, historyMessages: history });
    expect(final.qualitySafetyHold).not.toBe(true); expect(final.text).toBe(text);
    expect(text).toContain('一通の文面にまとめてください');
  });
  it('preserves the valid SMA action across actual normalization', () => {
    const f = finitePublicStageFixtures[9]; const history = f.history.map(message => ({ ...message })) as CoachingChatMessage[];
    const candidate = buildFinalVerifiedQualityFallback(f.latest, history);
    const text = normalizeCoachingOutput(candidate, f.latest, history);
    const quality = assessCoachingResponseQuality({ text, lastUserText: f.latest, historyMessages: history });
    replayed.push({ id: 'finite-sma-normalization', history, latest: f.latest, candidate, final: text, quality });
    expect(text).toBe(candidate); expect(text).not.toContain('次に終わらせる用事'); expect(quality.issues).toEqual([]);
  });
  it('does not turn an assistant-only school proposal into the user requested agreement', () => {
    const f = finitePublicStageFixtures[11]; const history = f.history.map(message => ({ ...message })) as CoachingChatMessage[];
    const text = buildFinalVerifiedQualityFallback(f.latest, history);
    const quality = assessCoachingResponseQuality({ text, lastUserText: f.latest, historyMessages: history });
    replayed.push({ id: 'finite-school-grounding', history, latest: f.latest, final: text, quality });
    expect(text).not.toMatch(/親子|叩く|蹴る|命令して手を/); expect(text).toContain('相手に確認したい約束'); expect(quality.issues).toEqual([]);
  });
});

const actualMissingRentExplanation = {
  "latest": "夫が家賃を払わない理由を何度聞いても、説明がありません。",
  "history": [],
  "candidate": "何度問いかけても対話を拒まれ、これ以上どう働きかければよいか途方に暮れてしまいますよね。夫は言葉での追及から逃げている可能性があります。\n\n夫は家賃を払わない理由を何と説明していますか？"
};
describe('group nineteen direct minimal verification', () => {
  it('detects the exact unsupported psychology and repeated explanation question', () => {
    const f = actualMissingRentExplanation;
    const quality = assessCoachingResponseQuality({ text: f.candidate, lastUserText: f.latest, historyMessages: [] });
    replayed.push({ id: 'rent-explanation-original-detection', ...f, quality });
    expect(quality.issues).toContain('context_mismatch');
  });
  it.each(['minimal', 'legacy'])('repairs the original direct candidate without a generic retry in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const f = actualMissingRentExplanation;
    const quality = assessCoachingResponseQuality({ text: f.candidate, lastUserText: f.latest, historyMessages: [] });
    const final = ensureVerifiedCoachingResolution({ resolution: { text: f.candidate, usage: {}, modelName: 'local-fixture-input', provider: 'local', repairAttempted: false, repairAccepted: false, initialIssues: quality.issues, finalIssues: quality.issues }, lastUserText: f.latest, historyMessages: [] });
    replayed.push({ id: 'rent-explanation-direct-verification', mode, ...f, initialQuality: quality, final });
    expect(final.qualitySafetyHold).not.toBe(true); expect(final.text).not.toMatch(/対話を拒|途方に暮|追及から逃げ|何と説明していますか|もう一度送って/);
    expect(final.text).toContain('記録してください'); expect(assessCoachingResponseQuality({ text: final.text, lastUserText: f.latest, historyMessages: [] }).issues).toEqual([]);
  });
});

const containsUnsupportedRentExplanationReply = actionLanguage.containsUnsupportedRentExplanationReply;
// Bounded current-user grounding controls for the observed rent reply.
const missingRentUser = '夫が家賃を払わない理由を何度聞いても、説明がありません。';
const reaskedRentReason = '夫は家賃を払わない理由を何と説明していますか？';
const oldRentReply = '何度問いかけても対話を拒まれ、これ以上どう働きかければよいか途方に暮れてしまいますよね。夫は言葉での追及から逃げている可能性があります。\n\n' + reaskedRentReason;
describe('known missing rent explanation must not turn into a reason re-question or inferred motive', () => {
  it.each([oldRentReply, reaskedRentReason, '対話を拒まれているのですね。', '途方に暮れてしまいますよね。', '夫は追及から逃げている可能性があります。', '夫は追及から逃げているのかもしれません。', '途方に暮れる理由は何ですか？', '夫へ「私は途方に暮れています」と伝えてください。'])('rejects the known reply family: %s', text=>{
    expect(containsUnsupportedRentExplanationReply(text,[missingRentUser])).toBe(true);
  });
  it.each([
    '理由が分からない以上、経済状況や意図を推測することはできません。直近3か月の家賃額と支払額を記録してください。',
    '途方に暮れているとは断定できません。',
    '夫が追及から逃げているとは判断できません。',
    'もし本当に対話を拒まれているなら、第三者に相談する方法があります。',
    '途方に暮れていますか？',
  ])('keeps a grounded response or genuine non-assertive clause: %s', text=>{
    expect(containsUnsupportedRentExplanationReply(text,[missingRentUser])).toBe(false);
  });
  it('does not let a preceding faithful quote exempt a new outside inference',()=>{
    const report='「夫は追及から逃げている」とAIに言われました。';
    expect(containsUnsupportedRentExplanationReply('「夫は追及から逃げている」とAIに言われたのですね。あなたは途方に暮れています。',[missingRentUser,report])).toBe(true);
  });
  it('keeps faithful nested quote reporting but not a new quoted outbound draft',()=>{
    const report='「AIは『途方に暮れている』と書いた」と言われました。';
    expect(containsUnsupportedRentExplanationReply('「AIは『途方に暮れている』と書いた」と言われたのですね。',[missingRentUser,report])).toBe(false);
    expect(containsUnsupportedRentExplanationReply('夫へ「途方に暮れています」と伝えてください。',[missingRentUser])).toBe(true);
  });
  it('requires current explicit user evidence for each distinct family',()=>{
    expect(containsUnsupportedRentExplanationReply('途方に暮れているのですね。',[missingRentUser,'私は途方に暮れています。'])).toBe(false);
    expect(containsUnsupportedRentExplanationReply('対話を拒まれているのですね。',[missingRentUser,'私は対話を拒まれています。'])).toBe(false);
    expect(containsUnsupportedRentExplanationReply('夫は追及から逃げていますね。',[missingRentUser,'夫は追及から逃げています。'])).toBe(false);
    expect(containsUnsupportedRentExplanationReply('途方に暮れているのですね。',[missingRentUser,'はぐらかされました。深刻な話です。'])).toBe(true);
  });
  it('does not use an assistant claim, quote, third-party state or user question as own current evidence',()=>{
    for(const extra of ['「私は途方に暮れています」とAIに言われました。','友人は途方に暮れています。','私は途方に暮れていますか？','もし私が途方に暮れているなら相談したいです。']) expect(containsUnsupportedRentExplanationReply('途方に暮れているのですね。',[missingRentUser,extra])).toBe(true);
    // Caller contract test: assistant history is never passed as user evidence.
    const history=[{role:'user',content:missingRentUser},{role:'assistant',content:'途方に暮れているのですね。'}];
    expect(containsUnsupportedRentExplanationReply('途方に暮れているのですね。',history.filter(m=>m.role==='user').map(m=>m.content))).toBe(true);
  });
  it('honors later denial and separates a faithful past acknowledgement from a current assertion',()=>{
    expect(containsUnsupportedRentExplanationReply('途方に暮れているのですね。',[missingRentUser,'私は途方に暮れています。','途方に暮れてはいません。'])).toBe(true);
    const users=[missingRentUser,'以前は途方に暮れていました。'];
    expect(containsUnsupportedRentExplanationReply('以前は途方に暮れていたのですね。',users)).toBe(false);
    expect(containsUnsupportedRentExplanationReply('今は途方に暮れているのですね。',users)).toBe(true);
    expect(containsUnsupportedRentExplanationReply('以前は途方に暮れていたのですね。',[missingRentUser])).toBe(true);
  });
  it('does not promote quoted, hypothetical, questioned or third-party missing-explanation reports into own current state',()=>{
    for(const user of ['「夫が家賃を払わない理由を何度聞いても、説明がありません」とAIに言われました。','もし夫が家賃を払わず説明がありませんという場合ならどうしますか？','夫が家賃を払わない理由の説明がありませんか？','友人の夫が家賃を払わない理由を何度聞いても、説明がありません。']) expect(containsUnsupportedRentExplanationReply(reaskedRentReason,[user])).toBe(false);
  });
  it('clears the missing state when the same reason is later explained or explicitly corrected',()=>{
    expect(containsUnsupportedRentExplanationReply(reaskedRentReason,[missingRentUser,'その後、理由を説明してくれました。'])).toBe(false);
    expect(containsUnsupportedRentExplanationReply(reaskedRentReason,[missingRentUser,'説明がないとは言っていません。'])).toBe(false);
    expect(containsUnsupportedRentExplanationReply(reaskedRentReason,['話題を変えて、資料の言い換えについて相談したいです。'])).toBe(false);
  });
});
// Integration contract for parent merge: keep its existing exact original
// direct ensure(raw) and normalize→ensure(normalized), minimal/legacy/observe
// witnesses. Add the shared predicate to real smoke/evaluator checks with
// currentTopicUserTexts(history-user + latest), not assistant or later turns.
// Add real VM negative/positive assertions for oldRentReply and neutral record
// response. Do not claim fullstream/DB/provider evidence from this helper block.

// Root's three finite static findings on draft v2, not new provider cases.
describe('same-subject passive and active rent reply grounding',()=>{
  it('keeps the explicitly reported husband active refusal rather than treating it as the user passive state',()=>{
    expect(containsUnsupportedRentExplanationReply('夫は対話を拒んでいるのですね。',[missingRentUser,'夫は対話を拒んでいます。'])).toBe(false);
    expect(containsUnsupportedRentExplanationReply('対話を拒まれているのですね。',[missingRentUser,'私は対話を拒まれています。'])).toBe(false);
  });
  it('does not lend a user emotion to an explicit husband subject',()=>{
    expect(containsUnsupportedRentExplanationReply('夫は途方に暮れているのですね。',[missingRentUser,'私は途方に暮れています。'])).toBe(true);
    expect(containsUnsupportedRentExplanationReply('あなたは途方に暮れているのですね。',[missingRentUser,'私は途方に暮れています。'])).toBe(false);
  });
  it('honors active refusal denial instead of treating the で or して prefix as affirmative',()=>{
    for(const denial of ['夫は対話を拒んではいません。','夫は対話を拒否していません。']) {
      expect(containsUnsupportedRentExplanationReply('夫は対話を拒んでいるのですね。',[missingRentUser,'夫は対話を拒んでいます。',denial])).toBe(true);
      expect(containsUnsupportedRentExplanationReply(denial,[missingRentUser])).toBe(false);
    }
  });
});

// Independent static review corrections to the same state/report contracts.
describe('missing rent reason state and report identity remain precise',()=>{
  it('does not let a corrected missing report re-enter the same affirmative branch',()=>{
    expect(containsUnsupportedRentExplanationReply(reaskedRentReason,[missingRentUser,'説明がないとは言っていません。'])).toBe(false);
  });
  it('does not let another person explain away this husband reason-absence',()=>{
    expect(containsUnsupportedRentExplanationReply(reaskedRentReason,[missingRentUser,'友人は理由を説明してくれました。'])).toBe(true);
    expect(containsUnsupportedRentExplanationReply(reaskedRentReason,[missingRentUser,'夫は理由を説明してくれました。'])).toBe(false);
  });
  it('does not change the speaker of a faithful quoted report',()=>{
    const userReport='「夫は追及から逃げている」とAIに言われました。';
    expect(containsUnsupportedRentExplanationReply('「夫は追及から逃げている」とAIに言われたのですね。',[missingRentUser,userReport])).toBe(false);
    expect(containsUnsupportedRentExplanationReply('「夫は追及から逃げている」と担当者に言われたのですね。',[missingRentUser,userReport])).toBe(true);
  });
});

describe('real production assertions reject unsupported missing-rent explanations', () => {
  function rentSmokeResult(message: string) {
    return { ...result(message), label: 'rent-explanation-control', lastUserText: missingRentUser, currentUserTexts: [missingRentUser] };
  }
  function rentEvaluationChecks(message: string) {
    const turn = { user: missingRentUser, label: 'rent-explanation-control-1', message, rawMessage: message, status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP', firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] };
    return evaluate([{ name: 'rent-explanation-control', seedHistory: [], turns: [turn] }]).checks.filter((check: { name: string }) => /説明がない話に心理や動機/.test(check.name));
  }
  it('uses the shared check in actual smoke assertions', () => {
    expect(() => smoke([rentSmokeResult(oldRentReply)])).toThrow(/inferred a rent motive/);
    const final = buildFinalVerifiedQualityFallback(missingRentUser, []);
    expect(() => smoke([rentSmokeResult(final)])).not.toThrow();
  });
  it('uses the shared check in the actual quality evaluator', () => {
    expect(rentEvaluationChecks(oldRentReply)).toEqual([{ name: 'rent-explanation-control-1: 説明がない話に心理や動機と同じ理由質問を足さない', passed: false }]);
    const final = buildFinalVerifiedQualityFallback(missingRentUser, []);
    expect(rentEvaluationChecks(final)).toEqual([{ name: 'rent-explanation-control-1: 説明がない話に心理や動機と同じ理由質問を足さない', passed: true }]);
  });
});
