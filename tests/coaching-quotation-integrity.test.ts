import vm from 'node:vm';
import * as actionLanguage from '../src/lib/coaching-action-language.mjs';
import * as quotationLanguage from '../src/lib/coaching-quotation-language.mjs';
import * as emotionLanguage from '../src/lib/coaching-emotion-language.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ raw: '', external: 0, alerts: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => ({ stream: (async function* () { yield { text: () => transport.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }),
  sendMessage: async () => ({ response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }),
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.external++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alerts++; throw new Error('ALERT_FORBIDDEN'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, buildGeminiParts, createJsonLineStream, normalizeCoachingOutput, type CoachingChatMessage } from '../src/lib/coaching-gemini';
import { getContextualizedPrompt } from '../src/data/coaching-system-prompt';
// Exact captured LOCAL synthetic provider candidate and public final on 90b7c94.
// This is not a reconstructed production provider response.
const fixture = {
  "history": [
    {
      "role": "user",
      "content": "仕事の予定が変わり、落ち着いて対応する方法を考えたいです。"
    },
    {
      "role": "assistant",
      "content": "直近の作業ややり取りを一つずつ整理できます。"
    },
    {
      "role": "user",
      "content": "今日の準備は終わりました。"
    },
    {
      "role": "assistant",
      "content": "その後、何かやり取りはありましたか？"
    },
    {
      "role": "user",
      "content": "解約したいと相手から言われました。"
    },
    {
      "role": "assistant",
      "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
    }
  ],
  "latest": "次回もどうぞよろしくお願いします。",
  "raw": "相手から解約したいと言われた直後であれば、「次回もどうぞよろしくお願いします」と返す前に、まずは相手の意向をそのまま受け止めた返答をする選択肢もあります。\n\n「解約のご希望について承知いたしました。」とだけ送る形はいかがでしょうか。",
  "badFinal": "相手から解約したいと言われた直後であれば、「次回もどうぞよろしくお願いします」と返す前に、まずは相手の意向をそのまま受け止めた返答をする選択肢もあります。\n\n「解約のご希望についてわかりました。"
};
const edits = [
  {
    "id": "partial-Friday-no-hour-1",
    "mode": "minimal",
    "inputHistory": [
      {
        "role": "user",
        "content": "サービスの説明資料を作っています。一枚目は利用目的で二枚目は利用手順です。"
      },
      {
        "role": "user",
        "content": "説明資料の締切は火曜午前10時です。"
      },
      {
        "role": "user",
        "content": "締切は金曜に変更されました。"
      },
      {
        "role": "user",
        "content": "今日は一枚目から直そうと思います。"
      }
    ],
    "inputLatest": "目的の説明が長くなりすぎています。",
    "mockCandidate": "火曜午前10時の締切までに今日最初に直すのは、一枚目の利用目的です。一枚目の説明を「このサービスで何ができるか」が一文で伝わる長さまで削り、その後で補足が必要かを見直してください。",
    "actualPublicDoneFinalCallback": "今日最初に直すのは、一枚目の利用目的です。読み手がサービスで何をできるのかをつかめるよう、一枚目の長い説明から「このサービスで何ができるか」を示す一文だけを選び、ほかの説明はいったん外してください。"
  },
  {
    "id": "cancelled-deadline-1",
    "mode": "minimal",
    "inputHistory": [
      {
        "role": "user",
        "content": "サービスの説明資料を作っています。一枚目は利用目的で二枚目は利用手順です。"
      },
      {
        "role": "user",
        "content": "説明資料の締切は火曜午前10時です。"
      },
      {
        "role": "user",
        "content": "締切はなくなりました。"
      },
      {
        "role": "user",
        "content": "今日は一枚目から直そうと思います。"
      }
    ],
    "inputLatest": "目的の説明が長くなりすぎています。",
    "mockCandidate": "火曜午前10時の締切までに今日最初に直すのは、一枚目の利用目的です。一枚目の説明を「このサービスで何ができるか」が一文で伝わる長さまで削り、その後で補足が必要かを見直してください。",
    "actualPublicDoneFinalCallback": "今日最初に直すのは、一枚目の利用目的です。読み手がサービスで何をできるのかをつかめるよう、一枚目の長い説明から「このサービスで何ができるか」を示す一文だけを選び、ほかの説明はいったん外してください。"
  }
];

const replayed: unknown[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => {
  const output = process.env.ACTI_QUOTATION_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ network: 0, cases: replayed }, null, 2), { flag: 'wx', mode: 0o600 });
});
function quotedProposalComplete(text: string) {
  expect(text).toContain('「解約のご希望について承知いたしました。」');
  expect(text).toContain('とだけ送る形はいかがでしょうか。');
  expect((text.match(/「/g) || []).length).toBe((text.match(/」/g) || []).length);
}
describe('complete quoted proposal survives output shaping', () => {
  it('keeps the actual complete provider proposal, its polite wording and closing quote', () => {
    quotedProposalComplete(normalizeCoachingOutput(fixture.raw, fixture.latest, fixture.history as CoachingChatMessage[]));
  });
  it('does not accept the actual truncated public final as complete', () => {
    expect(assessCoachingResponseQuality({ text: fixture.badFinal, lastUserText: fixture.latest, historyMessages: fixture.history as CoachingChatMessage[] }).issues).toContain('fragmented_expression');
  });
  it.each(['minimal', 'legacy', 'observe'])('keeps the complete actual raw through full streaming in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    vi.stubGlobal('fetch', async () => { transport.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
    transport.raw = fixture.raw;
    const callbacks: { message?: string }[] = [];
    const stream = createJsonLineStream({ systemPrompt: getContextualizedPrompt('MME-3'), historyMessages: fixture.history as CoachingChatMessage[],
      lastUserParts: buildGeminiParts(fixture.latest, [], []), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } });
    const reader = stream.getReader(); const decoder = new TextDecoder(); let body = '';
    while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value, { stream: true }); }
    body += decoder.decode();
    const events = body.trim().split('\n').map(line => JSON.parse(line));
    const dones = events.filter(event => event.type === 'done'); expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
    const done = dones[0];
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
    expect(callbacks[0].message).toBe(done.message);
    replayed.push({ name: 'actual-quoted-proposal', mode, history: fixture.history, input: fixture.latest, injectedCapturedLocalRaw: fixture.raw, final: done.message, initialIssues: done.qualityInitialIssues, finalIssues: done.qualityFinalIssues });
    quotedProposalComplete(done.message);
    expect(transport.external).toBe(0); expect(transport.alerts).toBe(0); expect(transport.fetch).toBe(0);
  });
});
describe('planning fallback ends with one writing action', () => {
  it.each(edits)('repairs the observed select-then-remove final: $id', f => {
    const text = buildFinalVerifiedQualityFallback(f.inputLatest, f.inputHistory as CoachingChatMessage[]);
    expect(text).not.toMatch(/選び|外してください|残し|削って|見直し/);
    expect(text).toMatch(/一文[^。]*書き直してください/);
    expect(text).not.toMatch(/火曜|午前10時/);
  });
  it('does not assume a first-page draft already exists', () => {
    const text = buildFinalVerifiedQualityFallback('一枚目には利用目的を書く予定です。', [{ role: 'user', content: 'サービスの説明資料を作っています。' }]);
    expect(text).toMatch(/一文で書いてください/);
    expect(text).not.toMatch(/書き直し|見直し|削っ|残し/);
  });
  it('uses one rewrite action when revising the first page', () => {
    const text = buildFinalVerifiedQualityFallback('今日は一枚目から直そうと思います。', [{ role: 'user', content: 'サービスの説明資料を作っています。一枚目は利用目的です。' }]);
    expect(text).toMatch(/一文[^。]*書き直してください/);
    expect(text).not.toMatch(/残し|削っ|選び|見直し/);
  });
});

const { splitOutsideJapaneseQuotations: split, containsUnbalancedJapaneseQuotation: incomplete, softenAcknowledgementsOutsideQuotations: soften } = quotationLanguage;
describe('quotation boundaries and tone are lossless', () => {
  it.each([
    ['「お願いします。承知しました。」と送ってください。', ['「お願いします。承知しました。」と送ってください。']],
    ['「外側『内側。』です。」と送ってください。次の説明です。', ['「外側『内側。』です。」と送ってください。', '次の説明です。']],
    ['「一行目。\n二行目です。」と送ってください。', ['「一行目。\n二行目です。」と送ってください。']],
    ['「お願いします？」と送ってはどうでしょうか？', ['「お願いします？」と送ってはどうでしょうか？']],
    ['一文です。\n\n「二文です。」と送ってください。', ['一文です。', '\n', '\n', '「二文です。」と送ってください。']],
  ])('does not filter fragments from a quoted sentence: %s', (text, expected) => {
    expect(split(text as string)).toEqual(expected); expect(split(text as string).join('')).toBe(text);
  });
  it.each(['「途中です。', '途中です。」', '「外側『内側。」』'])('detects missing or mismatched closings: %s', text => { expect(incomplete(text)).toBe(true); });
  it.each(['引用なしです。', '「閉じた文です。」', '「外側『内側。』です。」'])('keeps complete quotation: %s', text => { expect(incomplete(text)).toBe(false); });
  it.each([
    ['承知いたしました。「承知いたしました。」と送ってください。', 'わかりました。「承知いたしました。」と送ってください。'],
    ['承知しました。『承知しました。』と伝えてください。', 'わかりました。『承知しました。』と伝えてください。'],
    ['「外側「内側。」承知いたしました。」承知しました。', '「外側「内側。」承知いたしました。」わかりました。'],
    ['了解したと承知しました。「外側『承知いたしました。』です。」', '了解した、確認しました。「外側『承知いたしました。』です。」'],
  ])('changes the coach voice while preserving the proposed wording: %s', (text, expected) => { expect(soften(text)).toBe(expected); });
  it('keeps the complete actual quotation normalization idempotent', () => {
    const once = normalizeCoachingOutput(fixture.raw, fixture.latest, fixture.history as CoachingChatMessage[]);
    expect(normalizeCoachingOutput(once, fixture.latest, fixture.history as CoachingChatMessage[])).toBe(once);
  });
});
const containsEditing = actionLanguage.containsChainedEditingInstructions;
describe('editing instructions obey the ordinary one-action rule', () => {
  it.each([
    edits[0].actualPublicDoneFinalCallback,
    '一枚目の見出しと説明を見直し、利用目的が一文で読める形に絞ってください。',
    '「目的の一文」を残し、他の文はいったん削ってください。',
  ])('detects two editing actions in one sentence: %s', text => { expect(containsEditing(text, '説明が長すぎています。')).toBe(true); });
  it.each([
    '利用目的が一文で伝わる形に書き直してください。',
    '一文を選び、ほかの文は外しました。',
    '「一文を選び、ほかの文は外してください」という文案です。',
    'どの一文を残したいですか？',
    'この一文だけ残してください。',
  ])('keeps one action, reports and quoted content: %s', text => { expect(containsEditing(text, '説明が長すぎています。')).toBe(false); });
  it.each(['二つの作業を提案してください。', '修正の手順を説明してください。'])('allows a current affirmative multiple-action request: %s', request => { expect(containsEditing(edits[0].actualPublicDoneFinalCallback, request)).toBe(false); });
  it.each(['二つ提案しないでください。', '「二つ提案してください」とは頼んでいません。', '二つ提案してください。二つはやめてください。', '手順を説明せず、一つだけ提案してください。'])('does not infer a multiple-action waiver: %s', request => { expect(containsEditing(edits[0].actualPublicDoneFinalCallback, request)).toBe(true); });
  it.each(edits)('rejects the actual defective final in the quality assessor: $id', f => {
    expect(assessCoachingResponseQuality({ text: f.actualPublicDoneFinalCallback, lastUserText: f.inputLatest, historyMessages: f.inputHistory as CoachingChatMessage[] }).issues).toContain('multiple_coaching_moves');
  });
});
const smokeSource = readFileSync(resolve(process.cwd(), 'scripts/smoke-coaching-chat.mjs'), 'utf8');
const smokeFunctions = smokeSource.slice(smokeSource.indexOf('function assertResults('), smokeSource.indexOf('async function cleanup('));
const smoke = vm.runInNewContext(`${smokeFunctions}\nassertResults`, { ...actionLanguage, ...quotationLanguage, expectedTextModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000 });
const evaluatorSource = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = evaluatorSource.slice(evaluatorSource.indexOf('const BASELINE_QUALITY_POPULATION ='), evaluatorSource.indexOf('const args ='));
const evaluation = evaluatorSource.slice(evaluatorSource.indexOf('function evaluateConversations('), evaluatorSource.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  ...actionLanguage, ...quotationLanguage, ...emotionLanguage, containsDeadlineOutcomeAssurance,
  seededContinuityScenarios, evaluateSeededContinuityResponse,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
function result(message: string) { return { label: 'quotation-editing', lastUserText: fixture.latest, currentUserTexts: fixture.history.filter(m => m.role === 'user').map(m => m.content).concat(fixture.latest), userGrounding: {}, status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP', expectedFinishReason: 'STOP', expectedModelName: '', requiredResponseFragments: [], firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [], message }; }
function checks(message: string) { return evaluate([{ name: 'quotation-editing', seedHistory: fixture.history, turns: [{ ...result(message), user: fixture.latest, rawMessage: message }] }]).checks as { name: string; passed: boolean }[]; }
describe('production assertions detect the exact observed defects', () => {
  it('rejects the truncated quotation in the real smoke assertion', () => { expect(() => smoke([result(fixture.badFinal)])).toThrow(/incomplete Japanese quotation|unbalanced Japanese delimiters/i); });
  it('rejects the chained edit in the real smoke assertion', () => { expect(() => smoke([result(edits[0].actualPublicDoneFinalCallback)])).toThrow(/chained editing/i); });
  it('rejects the truncated quotation in the real evaluator', () => { const c = checks(fixture.badFinal).filter(c => /日本語の引用/.test(c.name)); expect(c).toHaveLength(1); expect(c[0].passed).toBe(false); });
  it('rejects the chained edit in the real evaluator', () => { const c = checks(edits[0].actualPublicDoneFinalCallback).filter(c => /文章を選ぶ準備/.test(c.name)); expect(c).toHaveLength(1); expect(c[0].passed).toBe(false); });
  it('accepts the complete actual quotation in both real checks', () => { expect(() => smoke([result(fixture.raw)])).not.toThrow(); expect(checks(fixture.raw).filter(c => /日本語の引用|文章を選ぶ準備/.test(c.name)).every(c => c.passed)).toBe(true); });
});

describe('quoted proposal has only its outside question counted', () => {
  it('keeps a quoted question plus a single outside proposal question', () => {
    const raw = '「解約のご希望について確認してもよろしいですか？」と送る形はいかがでしょうか？';
    const text = normalizeCoachingOutput(raw, fixture.latest, fixture.history as CoachingChatMessage[]);
    expect(text).toBe(raw);
  });
  it('preserves an entirely complete quote across blank lines', () => {
    const raw = '「解約のご希望について承知いたしました。\n\nご利用ありがとうございました。」とだけ送る形はいかがでしょうか。';
    const text = normalizeCoachingOutput(raw, fixture.latest, fixture.history as CoachingChatMessage[]);
    expect(text).toBe(raw);
  });
  it('still rejects a separate question following a standalone proposal', () => {
    expect(() => smoke([result('「明日までにお返事をお願いします」\n\n相手の返答をどう予想していますか？')])).toThrow();
  });
});
async function replayEdit(f: typeof edits[number], raw: string, mode: string) {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
  vi.stubGlobal('fetch', async () => { transport.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
  transport.raw = raw;
  const callbacks: { message?: string }[] = [];
  const stream = createJsonLineStream({ systemPrompt: getContextualizedPrompt('MME-3'), historyMessages: f.inputHistory as CoachingChatMessage[],
    lastUserParts: buildGeminiParts(f.inputLatest, [], []), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } });
  const reader = stream.getReader(); const decoder = new TextDecoder(); let body = '';
  while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value, { stream: true }); }
  body += decoder.decode();
  const events = body.trim().split('\n').map(line => JSON.parse(line));
  const dones = events.filter(event => event.type === 'done'); expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
  const done = dones[0];
  expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
  expect(callbacks[0].message).toBe(done.message);
  replayed.push({ name: f.id, mode, history: f.inputHistory, input: f.inputLatest, injectedLocalText: raw, injectionKind: raw === f.mockCandidate ? 'original-finite-mock' : 'actual-local-public-final', final: done.message, initialIssues: done.qualityInitialIssues, finalIssues: done.qualityFinalIssues });
  expect(transport.external).toBe(0); expect(transport.alerts).toBe(0); expect(transport.fetch).toBe(0);
  return done;
}
describe('both exact planning failures recover through full offline streaming', () => {
  for (const f of edits) for (const kind of ['mockCandidate', 'actualPublicDoneFinalCallback'] as const) {
    it.each(['minimal', 'legacy'])('repairs '+f.id+' '+kind+' in %s', async mode => {
      const done = await replayEdit(f, f[kind], mode);
      expect(done.message).toMatch(/一文[^。]*書き直してください/);
      expect(done.message).not.toMatch(/火曜|午前10時|選び|外してください|残し|削って|見直し/);
      expect(done.qualityFinalIssues).toEqual([]);
    });
    it('detects '+f.id+' '+kind+' in observe without rewriting', async () => {
      const done = await replayEdit(f, f[kind], 'observe');
      expect(done.message).toBe(f[kind]);
      expect(done.qualityInitialIssues.length).toBeGreaterThan(0);
    });
  }
});

describe('editing chains cannot evade the one-action rule using sentence boundaries', () => {
  it.each([
    '一枚目の説明から一文を選んでください。ほかの説明を外してください。',
    '一枚目の説明を見直してください。利用目的が一文で読める形に絞ってください。',
    '一文を選び、ほかの説明を外してくださいね。',
  ])('detects both instructed edits: %s', text => {
    expect(containsEditing(text, '説明が長すぎています。')).toBe(true);
    expect(assessCoachingResponseQuality({ text, lastUserText: '説明が長すぎています。' }).issues).toContain('multiple_coaching_moves');
  });
  it.each([
    '一文を選び、ほかの説明を外してくださいとAIに言われました。',
    '一文を選び、ほかの説明を外してくださいとは頼んでいません。',
  ])('does not turn an unquoted report into a current instruction: %s', text => { expect(containsEditing(text, '説明が長すぎています。')).toBe(false); });
});

describe('nested quotation content never becomes an outside question', () => {
  it.each([
    '「外側「内側。」確認できますか？」と送る形はいかがでしょうか？',
    '「外側『内側。』確認できますか？」と送る形はいかがでしょうか？',
  ])('preserves the whole quoted question and one outside proposal: %s', raw => {
    expect(quotationLanguage.stripJapaneseQuotationContent(raw)).toBe('と送る形はいかがでしょうか？');
    expect(normalizeCoachingOutput(raw, fixture.latest, fixture.history as CoachingChatMessage[])).toBe(raw);
    expect(assessCoachingResponseQuality({ text: raw, lastUserText: fixture.latest, historyMessages: fixture.history as CoachingChatMessage[] }).issues).not.toContain('multiple_coaching_moves');
  });
});

describe('nested quotations cannot create or waive an editing instruction', () => {
  it('keeps a nested original editing instruction as quoted content', () => {
    expect(containsEditing('原文は「引用「説明です。」一文を選び、ほかの説明を外してください。」です。', '説明が長すぎています。')).toBe(false);
  });
  it('keeps a nested original communication instruction as quoted content', () => {
    expect(actionLanguage.containsChainedCommunicationInstructions('原文は「引用「説明です。」希望を伝え、その後に一つ尋ねてください。」です。', fixture.latest)).toBe(false);
  });
  it('still detects the editing chain outside nested quoted content', () => {
    expect(containsEditing('原文は「引用「説明です。」」です。一文を選び、ほかの説明を外してください。', '説明が長すぎています。')).toBe(true);
  });
  it('still detects the communication chain outside nested quoted content', () => {
    expect(actionLanguage.containsChainedCommunicationInstructions('原文は「引用「説明です。」」です。希望を伝え、その後に一つ尋ねてください。', fixture.latest)).toBe(true);
  });
  it('does not treat a nested quoted multiple request as permission', () => {
    expect(containsEditing(edits[0].actualPublicDoneFinalCallback, '原文は「引用「説明です。」二つ提案してください。」です。')).toBe(true);
  });
  it('preserves the positions and widths of nonquoted text when masking', () => {
    const raw = '外「引用「内側。」😀文章」後'; const masked = quotationLanguage.stripJapaneseQuotationContent(raw, true);
    expect(masked.length).toBe(raw.length); expect(masked[0]).toBe('外'); expect(masked.at(-1)).toBe('後'); expect(masked.trim().replace(/ +/g, '')).toBe('外後');
  });
});

describe('quote-aware counting still rejects distinct standalone proposed actions', () => {
  const variants = ['「依頼事項を書き出してください。」\n\n「内容を確認してください。」', '「依頼事項を書き出してください」。\n\n「内容を確認してください」。'];
  it.each(variants)('counts two standalone quoted actions rather than dropping both from the counter: %s', two => {
    expect(assessCoachingResponseQuality({ text: two, lastUserText: '仕事を進めるには何をしたらよいですか？' }).issues).toContain('multiple_coaching_moves');
  });
  it.each(['「依頼事項を書き出してください。」', '「依頼事項を書き出してください」。'])('keeps a single standalone quoted proposal as one move: %s', text => {
    expect(assessCoachingResponseQuality({ text, lastUserText: '仕事を進めるには何をしたらよいですか？' }).issues).not.toContain('multiple_coaching_moves');
  });
  it.each(variants)('keeps only one complete quoted proposal during normalization: %s', two => {
    const text = normalizeCoachingOutput(two, '仕事を進めるには何をしたらよいですか？');
    expect((text.match(/ください/g) || []).length).toBe(1);
    expect(quotationLanguage.containsUnbalancedJapaneseQuotation(text)).toBe(false);
  });
});
