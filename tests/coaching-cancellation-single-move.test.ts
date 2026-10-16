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
// Exact inputs and public-final LOCAL SDK deliveries on failed fafc36a.
// These injected fixtures are not provider-original candidates.
const fixtures: { name: string; history: CoachingChatMessage[]; latest: string; observed: string }[] = [
  {
    "name": "draft-after-completed-work",
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
    "observed": "「次回もどうぞよろしくお願いします」を最初に伝える言葉の案として考えたのですね。仕事で解約の希望を受けた場面では、まず今回の希望を受け取ったことが相手に伝わる返答を置けます。理由が既に伝えられている場合は聞き直さず、確認が必要な点だけを残せます。\n\n最初は「解約をご希望なのですね」と伝え、その後に必要な確認が残っている場合だけ、一つ尋ねてください。"
  },
  {
    "name": "already-provided-cancellation-reason",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを一つ教えてください。"
      },
      {
        "role": "user",
        "content": "引っ越しが決まったので予約をキャンセルしたいと連絡を受けました。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "latest": "ご希望を伺いました。",
    "observed": "「ご希望を伺いました」を最初に伝える言葉の案として考えたのですね。仕事でキャンセルの希望を受けた場面では、まず今回の希望を受け取ったことが相手に伝わる返答を置けます。理由が既に伝えられている場合は聞き直さず、確認が必要な点だけを残せます。\n\n最初は「キャンセルをご希望なのですね」と伝え、その後に必要な確認が残っている場合だけ、一つ尋ねてください。"
  },
  {
    "name": "separately-supplied-reason",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを教えてください。"
      },
      {
        "role": "user",
        "content": "お客様からキャンセルの希望がありました。"
      },
      {
        "role": "assistant",
        "content": "理由について何か聞いていますか？"
      },
      {
        "role": "user",
        "content": "引っ越しが決まったそうです。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "latest": "ご希望を受け取りました。",
    "observed": "「ご希望を受け取りました」を最初に伝える言葉の案として考えたのですね。仕事でキャンセルの希望を受けた場面では、まず今回の希望を受け取ったことが相手に伝わる返答を置けます。理由が既に伝えられている場合は聞き直さず、確認が必要な点だけを残せます。\n\n最初は「キャンセルをご希望なのですね」と伝え、その後に必要な確認が残っている場合だけ、一つ尋ねてください。"
  }
];

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
const smokeFunctions = vm.runInNewContext(`${smokeAssertions}\n({ assertResults, countCoachingMoves })`, { ...actionLanguage, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, expectedTextModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000 });
const smoke = smokeFunctions.assertResults;
function smokeResult(message: string) {
  const f = fixtures[0];
  return { label: 'conditional-communication-chain', lastUserText: f.latest,
    currentUserTexts: [...f.history.filter(m => m.role === 'user').map(m => m.content), f.latest], userGrounding: {},
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP', expectedFinishReason: 'STOP', expectedModelName: '', requiredResponseFragments: [],
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityFinalIssues: [], message };
}
function evaluatorChecks(message: string) {
  const f = fixtures[0];
  const turn = { user: f.latest, label: 'conditional-communication-chain-1', message, rawMessage: message,
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP',
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] };
  return evaluate([{ name: 'conditional-communication-chain', seedHistory: f.history, turns: [turn] }]).checks as { name: string; passed: boolean }[];
}
describe('actual conditional second communication action', () => {
  it.each(fixtures)('detects both instructed actions without a user single-action request: $name', f => {
    expect(assessCoachingResponseQuality({ text: f.observed, lastUserText: f.latest, historyMessages: f.history }).issues).toContain('multiple_coaching_moves');
  });
  it.each(fixtures)('keeps the context and closes the fallback after one acknowledgement: $name', f => {
    const text = buildFinalVerifiedQualityFallback(f.latest, f.history);
    expect(text).toMatch(/解約|キャンセル/); expect(text).toContain('言葉の案');
    expect(text).not.toMatch(/伝え、その後|尋ねてください|質問してください/);
    expect(assessCoachingResponseQuality({ text, lastUserText: f.latest, historyMessages: f.history }).issues).toEqual([]);
  });
  it.each(fixtures)('rejects the actual chain in real smoke assertions: $name', f => {
    expect(() => smoke([smokeResult(f.observed)])).toThrow(/more than one coaching move|chained communication instructions/i);
  });
  it('rejects the actual chain in the real evaluator', () => {
    const checks = evaluatorChecks(fixtures[0].observed).filter(c => /連絡の後/.test(c.name));
    expect(checks).toHaveLength(1); expect(checks[0].passed).toBe(false);
  });
});

const contains = actionLanguage.containsChainedCommunicationInstructions;
describe('only actual communication instructions count as a chain', () => {
  it.each([
    '「解約をご希望なのですね」と伝え、その後に必要なら一つ尋ねてください。',
    '希望を伝えてから、必要な点を一つ質問してください。',
    '内容を説明し、続いて確認してください。',
    '希望を伝えた後に、質問してください。',
    '希望を伝え、その後に一つ聞きましょう。',
  ])('detects a second instruction outside quotes: %s', text => { expect(contains(text, 'ご希望を受け取りました。')).toBe(true); });
  it.each([
    '「解約をご希望なのですね」と伝えてください。',
    '必要な点が残っている場合だけ、一つ尋ねてください。',
    '希望を伝えた後に、質問しました。',
    '希望を伝え、その後の返答を振り返っています。',
    '「希望を伝え、その後に質問してください」と書いた文案です。',
    '「希望を伝えてから、質問してください」',
  ])('keeps one action, factual reports, reflection and quoted draft content: %s', text => { expect(contains(text, 'ご希望を受け取りました。')).toBe(false); });
  it('does not exempt an outside chain after quoted draft content', () => {
    expect(contains('「希望を伝え、その後に質問してください」という案を相手に伝え、その後一つ尋ねてください。', 'ご希望を受け取りました。')).toBe(true);
  });
  it('allows an explicit request for multiple actions', () => {
    expect(contains(fixtures[0].observed, '伝えることと質問することの両方を提案してください。')).toBe(false);
  });
  it('allows an explicit request for the sequence', () => {
    expect(contains(fixtures[0].observed, '伝えてから質問する手順を教えてください。')).toBe(false);
  });
  it('keeps a single-action request ahead of conflicting multiple wording', () => {
    expect(contains(fixtures[0].observed, '両方ではなく、一つだけ行動を提案してください。')).toBe(true);
  });
  it('does not treat a procedure fact as a multiple-action request', () => {
    expect(contains(fixtures[0].observed, '利用手順を書く予定です。')).toBe(true);
  });
  it('accepts the corrected acknowledgement in real production assertions', () => {
    const text = buildFinalVerifiedQualityFallback(fixtures[0].latest, fixtures[0].history);
    expect(() => smoke([smokeResult(text)])).not.toThrow();
    const checks = evaluatorChecks(text).filter(c => /連絡の後/.test(c.name));
    expect(checks).toHaveLength(1); expect(checks[0].passed).toBe(true);
  });
});
const replayed: unknown[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => {
  const output = process.env.ACTI_COMMUNICATION_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ network: 0, cases: replayed }, null, 2), { flag: 'wx', mode: 0o600 });
});
async function replay(f: typeof fixtures[number], mode: string) {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
  vi.stubGlobal('fetch', async () => { transport.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
  transport.raw = f.observed;
  const callbacks: { message?: string }[] = [];
  const stream = createJsonLineStream({ systemPrompt: getContextualizedPrompt('MGA-3'), historyMessages: f.history,
    lastUserParts: buildGeminiParts(f.latest, [], []), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } });
  const reader = stream.getReader(); const decoder = new TextDecoder(); let body = '';
  while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value, { stream: true }); }
  body += decoder.decode();
  const events = body.trim().split('\n').map(line => JSON.parse(line));
  const dones = events.filter(event => event.type === 'done'); expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
  const done = dones[0];
  expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
  expect(callbacks[0].message).toBe(done.message);
  replayed.push({ name: f.name, mode, history: f.history, input: f.latest, injectedPublicFinal: f.observed,
    final: done.message, initialIssues: done.qualityInitialIssues, finalIssues: done.qualityFinalIssues });
  expect(transport.external).toBe(0); expect(transport.alerts).toBe(0); expect(transport.fetch).toBe(0);
  return done;
}
describe('exact three local failures through full offline streaming', () => {
  for (const f of fixtures) {
    it.each(['minimal', 'legacy'])('recovers '+f.name+' in %s', async mode => {
      const done = await replay(f, mode); expect(done.message).not.toBe(f.observed);
      expect(done.message).toMatch(/解約|キャンセル/); expect(done.message).toContain('言葉の案');
      expect(contains(done.message, f.latest)).toBe(false); expect(done.qualityFinalIssues).toEqual([]);
    });
    it('detects '+f.name+' without rewriting in observe', async () => {
      const done = await replay(f, 'observe'); expect(done.message).toBe(f.observed);
      expect(done.qualityInitialIssues).toContain('multiple_coaching_moves');
    });
  }
});

describe('reported user wording is not a second suggestion', () => {
  it('counts the corrected actual acknowledgement as one action', () => {
    expect(smokeFunctions.countCoachingMoves(buildFinalVerifiedQualityFallback(fixtures[0].latest, fixtures[0].history))).toBe(1);
  });
  it('still counts a standalone proposed quote as a move', () => {
    expect(smokeFunctions.countCoachingMoves('「明日までにお返事をお願いします」')).toBe(1);
  });
  it('does not waive two separately instructed messages', () => {
    expect(smokeFunctions.countCoachingMoves('「予定を教えてほしいです」と伝えてください。「回答をお願いします」ともう一度伝えてください。')).toBeGreaterThan(1);
  });
  it('leaves the existing action plus coach closing-question policy in control', () => {
    expect(contains('「希望を受け取りました」と伝えてください。相手に何を伝えたいですか？', '行動を一つ提案し、最後に質問を一つしてください。')).toBe(false);
  });
});

describe('multiple-action exceptions require an affirmative current request', () => {
  it.each([
    '複数提案しないでください。',
    '手順を説明しないでください。',
    '「複数提案してください」とは頼んでいません。',
    '複数提案してください。やはり複数はやめてください。',
    '複数提案してくださいとは言っていません。',
    '複数提案してください。複数は必要ありません。',
    '複数提案してくださいと昔依頼しました。',
  ])('does not turn prohibition/report/revocation into permission: %s', request => {
    expect(contains(fixtures[0].observed, request)).toBe(true);
  });
  it.each(['質問の言い方は変えないで、伝えることと質問することの両方を提案してください。', '複数提案して', '両方提案してくださいね'])('keeps an affirmative request with ordinary wording: %s', request => {
    expect(contains(fixtures[0].observed, request)).toBe(false);
  });
});
