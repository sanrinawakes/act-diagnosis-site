import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as actionLanguage from '../src/lib/coaching-action-language.mjs';
import * as emotionLanguage from '../src/lib/coaching-emotion-language.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';
const transport = vi.hoisted(() => ({ raw: '', external: 0, alerts: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => ({ stream: (async function* () { yield { text: () => transport.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }),
  sendMessage: async () => ({ response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }),
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.external++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alerts++; throw new Error('ALERT_FORBIDDEN'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, buildGeminiParts, createJsonLineStream, type CoachingChatMessage } from '../src/lib/coaching-gemini';
import { getContextualizedPrompt } from '../src/data/coaching-system-prompt';
// Exact synthetic production request/public delivery from trace 57180-61 on
// 1a554c8. This is not a recovered provider-original candidate.
const history: CoachingChatMessage[] = [
  {
    "role": "user",
    "content": "新しい企画の説明資料を作っています。"
  },
  {
    "role": "assistant",
    "content": "企画の説明資料を作っているのですね。最初に読み手と資料の目的を決めると、載せる情報や説明の順番を選びやすくなります。すでに内容を書き始めていても、読み手が知っていることと、資料で初めて知ることを分けて確認できます。\n\nその資料は、誰に何を伝えるためのものですか？"
  },
  {
    "role": "user",
    "content": "対象は初めてサービスを使う人です。"
  },
  {
    "role": "assistant",
    "content": "企画の説明資料を読むのは、初めてサービスを使う人なのですね。読者が仕組みや用語を知っている前提を置かず、「何ができるか」「最初に何をするか」の順で説明すると理解しやすくなります。機能をすべて紹介する前に、読者が最初に達成したいことを決めると、必要な説明を選べます。\n\nその資料を読んだ人に、まず何ができるようになってほしいですか？"
  },
  {
    "role": "user",
    "content": "専門用語を減らしたいです。"
  },
  {
    "role": "assistant",
    "content": "資料の専門用語を減らしたいのですね。言葉を日常的な表現や具体的な動作に置き換えると、初めて使う人にも内容が伝わりやすくなります。資料全体を一度に変えず、一つの用語から言い換えを考えられます。\n\n今の資料で、まず言い換えたい専門用語は何ですか？"
  },
  {
    "role": "user",
    "content": "説明する順番にも迷っています。"
  },
  {
    "role": "assistant",
    "content": "順番に迷っているなら、資料全体を一度に直すより、一枚ごとの役割を固定した方が早いです。一枚目は「何のためのサービスか」、二枚目は「どう使うか」、三枚目以降で補足という順に並べてください。"
  },
  {
    "role": "user",
    "content": "一枚目には利用目的を書く予定です。"
  },
  {
    "role": "assistant",
    "content": "一枚目を利用目的にする方針で揃っているのですね。初めて使う人向けの資料なら、一枚目は「このサービスで何ができるか」を一文で言い切る役割に固定した方が、後ろの手順ページも組みやすくなります。まず一枚目の見出しと説明を見直し、利用目的が一文で読める形に絞ってください。"
  }
];
const latest = "二枚目には利用手順を書く予定です。";
const observed = "この企画の説明資料は、一枚目で利用目的を伝え、二枚目で利用手順を見せる並びですね。初めてサービスを使う人向けなら、二枚目は説明を増やすより、「1. 何を押すか」「2. 何が表示されるか」「3. 次に何をするか」の三段で読める形にした方が、専門用語に引っかからず流れを追いやすくなります。まず二枚目の手順を三段だけに絞って書き出してください。";

const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const spec = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${spec}\n${evaluation}\nevaluateConversations`, {
  ...actionLanguage, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, ...emotionLanguage, containsDeadlineOutcomeAssurance,
  seededContinuityScenarios, evaluateSeededContinuityResponse,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
const smokeSource = readFileSync(resolve(process.cwd(), 'scripts/smoke-coaching-chat.mjs'), 'utf8');
const smokeAssertions = smokeSource.slice(smokeSource.indexOf('function assertResults('), smokeSource.indexOf('async function cleanup('));
const smoke = vm.runInNewContext(`${smokeAssertions}\nassertResults`, { ...actionLanguage, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, expectedTextModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000 });
const userTexts = [...history.filter(m => m.role === 'user').map(m => m.content), latest];
function evaluatorChecks(message: string) {
  const turn = { user: latest, label: 'long-continuity-three-turn-reference-6', message, rawMessage: message,
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP',
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] };
  // A focused evaluator probe, separate from the unchanged live population.
  return evaluate([{ name: 'long-continuity-three-turn-reference', seedHistory: history, turns: [turn] }]).checks as { name: string; passed: boolean }[];
}
function smokeResult(message: string) {
  return { label: 'procedure-grounding', lastUserText: latest, currentUserTexts: userTexts, userGrounding: {},
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP', expectedFinishReason: 'STOP', expectedModelName: '', requiredResponseFragments: [],
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityFinalIssues: [], message };
}

describe('actual unsupported service-interface procedure', () => {
  it('rejects the exact public premise before recovery', () => {
    expect(assessCoachingResponseQuality({ text: observed, lastUserText: latest, historyMessages: history }).issues).toContain('context_mismatch');
  });
  it('assesses the neutral continuation itself', () => {
    const text = '企画の説明資料の二枚目には利用手順を書く予定なのですね。初めてサービスを使う人が流れを追えるよう、「最初にすること」「その結果」「次にすること」の三段を整理の枠として使えます。実際の手順の数や動作は、サービスの内容に合わせて考えます。まず二枚目の利用手順を、この並びに沿って書き出してください。';
    expect(assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: history }).issues).toEqual([]);
  });
  it('uses a medium-neutral document continuation', () => {
    const text = buildFinalVerifiedQualityFallback(latest, history);
    expect(text).toContain('二枚目'); expect(text).toContain('三段');
    expect(text).not.toMatch(/何を押すか|何が表示されるか|ボタン|クリック|タップ/);
    expect(assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: history }).issues).toEqual([]);
  });
  it('rejects the exact premise in the real production evaluator', () => {
    const checks = evaluatorChecks(observed).filter(c => /操作画面/.test(c.name));
    expect(checks).toHaveLength(1); expect(checks[0].passed).toBe(false);
  });
  it('rejects the exact premise in the real smoke assertions', () => {
    expect(() => smoke([smokeResult(observed)])).toThrow(/interface|procedure/i);
  });
});

const contains = actionLanguage.containsUnsupportedProcedureInterfacePremise;
describe('bounded interface grounding and counterexamples', () => {
  it.each([
    ['quoted labels', observed],
    ['button action', '二枚目にあるボタンを押す手順を書き出してください。'],
    ['tap action', '二枚目には画面をタップする手順を書いてください。'],
    ['display action', '二枚目には表示される画面の内容を書いてください。'],
    ['example without a condition', '例えば「何を押すか」「何が表示されるか」の順に手順を記してください。'],
    ['condition on reader only', '初めて使う人なら、何を押すかを書いてください。'],
    ['unrelated negation', '手順は難しくありませんが、何を押すかを書いてください。'],
    ['condition followed by independent assertion', 'もしボタンがあるなら確認できますが、何を押すかを書いてください。'],
  ])('detects an ungrounded procedure premise: %s', (_name, text) => {
    expect(contains(text, userTexts)).toBe(true);
  });
  it.each([
    ['affirmed real UI', 'サービスはウェブアプリで、画面にはボタンがあります。'],
    ['quoted button name with affirmative surrounding words', 'サービスの画面には「開始」ボタンがあります。'],
  ])('keeps user-established interface advice: %s', (_name, source) => {
    expect(contains(observed, [...userTexts, source])).toBe(false);
  });
  it.each([
    'AIに「画面にはボタンがあります」と言われました。',
    '画面にはボタンがありますか？',
    'もし画面にボタンがあれば説明に使えます。',
    '画面とボタンがある場合は説明に使います。',
    '例えば画面とボタンがある別のサービスを考えています。',
    '画面もボタンもありません。',
    '画面もボタンもまだありません。',
    '画面とボタンは存在しません。',
    '画面とボタンがあるか分かりません。',
    '画面とボタンがあるとは言っていません。',
  ])('does not promote a quote/question/hypothesis/denial into fact: %s', source => {
    expect(contains(observed, [...userTexts, source])).toBe(true);
  });
  it('applies a later user denial', () => {
    expect(contains(observed, [...userTexts, '画面にはボタンがあります。', '画面もボタンもありません。'])).toBe(true);
  });
  it('does not use the assistant history as user evidence', () => {
    expect(assessCoachingResponseQuality({ text: observed, lastUserText: latest,
      historyMessages: [...history, { role: 'assistant', content: 'サービスの画面にはボタンがあります。' }] }).issues).toContain('context_mismatch');
  });
  it('does not carry the UI from a previous topic', () => {
    expect(assessCoachingResponseQuality({ text: observed, lastUserText: latest,
      historyMessages: [{ role: 'user', content: '前のアプリの画面にはボタンがあります。' },
        { role: 'user', content: '話題を変えて、新しいサービスの説明資料を作ります。' }, ...history] }).issues).toContain('context_mismatch');
  });
  it('requires press evidence separately from display evidence', () => {
    expect(contains('何を押すかを書いてください。', [...userTexts, 'サービスの画面表示を説明しています。'])).toBe(true);
    expect(contains('何が表示されるかを書いてください。', [...userTexts, 'サービスにボタンがあります。'])).toBe(true);
  });
  it.each([
    'もしボタンがあるサービスなら、「何を押すか」を手順に示せます。',
    '仮に画面があるサービスなら、「何が表示されるか」を手順に示せます。',
    'ボタンを押すとは限りません。サービスに必要な動作を整理してください。',
    '二枚目に載せたい利用手順を、この画面に書いてください。',
    '二枚目の手順を「最初にすること」「その結果」「次にすること」で整理できます。',
  ])('keeps true UI conditions, negation, composer references and neutral advice: %s', text => {
    expect(contains(text, userTexts)).toBe(false);
  });
  it('does not classify unrelated coaching as service procedure advice', () => {
    expect(contains('この画面をタップしてください。', ['仕事で上司への返事をためらっています。'])).toBe(false);
  });
  it('accepts the actual neutral fallback in production assertions', () => {
    const text = buildFinalVerifiedQualityFallback(latest, history);
    expect(() => smoke([smokeResult(text)])).not.toThrow();
    const checks = evaluatorChecks(text).filter(c => /操作画面/.test(c.name));
    expect(checks).toHaveLength(1); expect(checks[0].passed).toBe(true);
  });
});

const replayed: { mode: string; input: string; history: CoachingChatMessage[]; injectedCandidate: string; final: string; initialIssues: string[]; finalIssues: string[] }[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => {
  const output = process.env.ACTI_PROCEDURE_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ network: 0, cases: replayed }, null, 2), { flag: 'wx', mode: 0o600 });
});
async function replay(raw: string, mode: string, messages: CoachingChatMessage[] = history) {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
  vi.stubGlobal('fetch', async () => { transport.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
  transport.raw = raw;
  const callbacks: { message?: string }[] = [];
  const stream = createJsonLineStream({ systemPrompt: getContextualizedPrompt('MGA-3'), historyMessages: messages,
    lastUserParts: buildGeminiParts(latest, [], []), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } });
  const reader = stream.getReader(); const decoder = new TextDecoder(); let body = '';
  while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value, { stream: true }); }
  body += decoder.decode();
  const events = body.trim().split('\n').map(line => JSON.parse(line));
  const dones = events.filter(event => event.type === 'done');
  expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
  const done = dones[0];
  expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
  expect(callbacks[0].message).toBe(done.message);
  replayed.push({ mode, input: latest, history: messages, injectedCandidate: raw, final: done.message, initialIssues: done.qualityInitialIssues, finalIssues: done.qualityFinalIssues });
  expect(transport.external).toBe(0); expect(transport.alerts).toBe(0); expect(transport.fetch).toBe(0);
  return done;
}
describe('actual procedure defect through the full offline stream', () => {
  it.each(['minimal', 'legacy'])('recovers exact public defect in %s', async mode => {
    const done = await replay(observed, mode);
    expect(done.message).not.toBe(observed); expect(done.message).toContain('二枚目');
    expect(contains(done.message, userTexts)).toBe(false);
    expect(done.qualityFinalIssues).toEqual([]);
  });
  it('detects without rewriting in observe mode', async () => {
    const done = await replay(observed, 'observe'); expect(done.message).toBe(observed);
    expect(done.qualityInitialIssues).toContain('context_mismatch');
  });
  it.each(['minimal', 'legacy'])('preserves user-established interface advice in %s', async mode => {
    const messages: CoachingChatMessage[] = [...history, { role: 'user', content: 'サービスの画面にはボタンがあります。' }];
    const done = await replay(observed, mode, messages);
    expect(done.message).toBe(observed); expect(done.qualityFinalIssues).toEqual([]);
  });
});

describe('ordinary UI conditions and existence checks', () => {
  it.each([
    'ボタン操作がある場合は、「何を押すか」を手順に示せます。',
    '画面操作がある場合は、「何が表示されるか」を手順に示せます。',
    'このサービスには操作画面がありますか？',
  ])('does not assume UI existence: %s', text => { expect(contains(text, userTexts)).toBe(false); });
  it.each([
    'もしボタンがないサービスなら、「何を押すか」を手順に示せます。',
    '画面操作がない場合は、「何が表示されるか」を手順に示せます。',
  ])('does not turn a UI absence condition into presence: %s', text => { expect(contains(text, userTexts)).toBe(true); });
  it('does not confuse a failed operation with an absent interface', () => {
    expect(contains(observed, [...userTexts, '画面でボタンを押しても動かないので利用手順を直したいです。'])).toBe(false);
  });
  it('still rejects a presupposing question about a UI property', () => {
    expect(contains('操作画面には何が表示されるか教えてください。', userTexts)).toBe(true);
  });
});

describe('adjacent application fallbacks do not assume a web form', () => {
  it.each([
    '応募の一歩がなかなか踏み出せません。',
    '求人への応募をためらっています。質問なしで、具体的な行動を一つだけ教えてください。',
  ])('keeps the proposed action independent of application medium: %s', request => {
    const messages: CoachingChatMessage[] = [{ role: 'user', content: 'アルバイトの候補は見つかっています。' }];
    const text = buildFinalVerifiedQualityFallback(request, messages);
    expect(text).not.toMatch(/応募ページ|入力欄|最初の項目/);
    expect(text).toContain('経験'); expect(text).toContain('一文');
    expect(assessCoachingResponseQuality({ text, lastUserText: request, historyMessages: messages }).issues).toEqual([]);
  });
});
