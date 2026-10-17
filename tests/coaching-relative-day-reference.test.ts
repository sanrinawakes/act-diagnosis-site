import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as actionLanguage from '../src/lib/coaching-action-language.mjs';
import * as emotionLanguage from '../src/lib/coaching-emotion-language.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';

vi.mock('@/lib/openai', () => ({ getGenAI: () => { throw new Error('NETWORK_DISABLED'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: () => { throw new Error('ALERT_DISABLED'); } }));

import { normalizeCoachingOutput } from '../src/lib/coaching-gemini';

// Exact synthetic production request/delivery from the failed 8845 quality run.
const latest = '同時接続テスト5です。明日の朝に始める行動を一つだけ、質問なしで答えてください。';
const observed = '明日の朝起きたら、まず今日行う作業を1つ紙に書き出してください。';
const alignedObserved = '明日の朝起きたら、まずその日に行う作業を1つ紙に書き出してください。';
const { containsAmbiguousFutureActionDayReference, alignFutureActionDayReferences } = actionLanguage;

// Evaluate the real assertion/evaluation functions with pure helpers only.
// Top-level scripts, clients, credentials, request and cleanup code never run.
const smokeSource = readFileSync(resolve(process.cwd(), 'scripts/smoke-coaching-chat.mjs'), 'utf8');
const smokeAssertions = smokeSource.slice(smokeSource.indexOf('function assertResults('), smokeSource.indexOf('async function cleanup('));
const assertSmokeResults = vm.runInNewContext(`${smokeAssertions}\nassertResults`, {
  ...actionLanguage, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, expectedTextModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
const evaluatorSource = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = evaluatorSource.slice(evaluatorSource.indexOf('const BASELINE_QUALITY_POPULATION ='), evaluatorSource.indexOf('const args ='));
const evaluation = evaluatorSource.slice(evaluatorSource.indexOf('function evaluateConversations('), evaluatorSource.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  ...actionLanguage, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, ...emotionLanguage, containsDeadlineOutcomeAssurance,
  seededContinuityScenarios, evaluateSeededContinuityResponse,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
function smokeResult(message: string) {
  return {
    label: 'parallel-burst-5-1', lastUserText: latest, currentUserTexts: [latest], userGrounding: {},
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP',
    expectedFinishReason: 'STOP', expectedModelName: '', requiredResponseFragments: [],
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityFinalIssues: [], message,
  };
}
function evaluatorChecks(message: string) {
  const turn = {
    user: latest, label: 'parallel-burst-5-1', message, rawMessage: message,
    status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP',
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [],
  };
  return evaluate([{ name: 'parallel-burst-5', seedHistory: [], turns: [turn] }]).checks as { name: string; passed: boolean }[];
}

describe('future action target day stays explicit', () => {
  it.each([
    [observed, '明日の朝起きたら、まずその日に行う作業を1つ紙に書き出してください。'],
    ['明日の朝、まず本日行う作業を一つ紙に書いてください。', '明日の朝、まずその日に行う作業を一つ紙に書いてください。'],
    ['明日の朝、今日やる用事を一つメモしてください。', '明日の朝、その日にやる用事を一つメモしてください。'],
    ['明日の朝起きたら、まず今日の作業を1つ紙に書き出してください。', '明日の朝起きたら、まずその日の作業を1つ紙に書き出してください。'],
    ['明日の朝、本日の仕事を一つメモしてください。', '明日の朝、その日の仕事を一つメモしてください。'],
  ])('aligns an ungrounded current-day task in a tomorrow action: %s', (candidate, expected) => {
    expect(normalizeCoachingOutput(candidate, latest, [])).toBe(expected);
  });

  it('keeps an already explicit execution-day reference', () => {
    const candidate = '明日の朝、その日に行う作業を一つ紙に書いてください。';
    expect(normalizeCoachingOutput(candidate, latest, [])).toBe(candidate);
  });

  it('preserves an explicit quoted future-day wording', () => {
    const candidate = '明日の朝、メモに「今日行う作業」と書いてください。';
    expect(normalizeCoachingOutput(candidate, latest, [])).toBe(candidate);
  });

  it('preserves a user-supplied distinction between today and tomorrow', () => {
    const request = '明日の朝に今日行う作業を振り返る行動を一つだけ、質問なしで教えてください。';
    const candidate = '明日の朝、今日行う作業を一つ思い出して紙に書いてください。';
    expect(normalizeCoachingOutput(candidate, request, [])).toBe(candidate);
  });

  it.each([
    observed,
    '明日の朝、まず本日行う作業を一つ紙に書いてください。',
    '明日の朝、今日やる用事を一つメモしてください。',
    '明日の朝起きたら、まず今日の作業を1つ紙に書き出してください。',
    '明日の朝、本日の仕事を一つメモしてください。',
  ])('detects the same target-day problem before alignment: %s', (candidate) => {
    expect(containsAmbiguousFutureActionDayReference(candidate, latest)).toBe(true);
    expect(containsAmbiguousFutureActionDayReference(alignFutureActionDayReferences(candidate, latest), latest)).toBe(false);
  });

  it('is idempotent and preserves the concrete observed action', () => {
    const first = alignFutureActionDayReferences(observed, latest);
    expect(first).toBe(alignedObserved);
    expect(alignFutureActionDayReferences(first, latest)).toBe(first);
    expect(normalizeCoachingOutput(first, latest, [])).toBe(first);
  });

  it.each([
    '明日の朝、今日行った作業を一つ紙に書いてください。',
    '明日の朝、今日できなかったことを一つ紙に書いてください。',
  ])('does not reinterpret past-day forms in the temporal helper: %s', (candidate) => {
    // This only checks the temporal rule, not unrelated factual-quality gates.
    expect(containsAmbiguousFutureActionDayReference(candidate, latest)).toBe(false);
    expect(alignFutureActionDayReferences(candidate, latest)).toBe(candidate);
  });

  it.each([
    '明日の朝、メモに「今日行う作業」と書いてください。',
    '明日の朝、メモに『今日行う作業』と書いてください。',
    '明日の朝、メモに"今日行う作業"と書いてください。',
    "明日の朝、メモに'今日行う作業'と書いてください。",
  ])('keeps a quoted phrase outside the target span: %s', (candidate) => {
    expect(containsAmbiguousFutureActionDayReference(candidate, latest)).toBe(false);
    expect(alignFutureActionDayReferences(candidate, latest)).toBe(candidate);
  });

  it('protects a quote without exempting a separate ambiguous instruction', () => {
    const candidate = '「今日行う作業」という表題は残します。明日の朝、まず今日行う作業を一つ紙に書いてください。';
    const expected = '「今日行う作業」という表題は残します。明日の朝、まずその日に行う作業を一つ紙に書いてください。';
    expect(containsAmbiguousFutureActionDayReference(candidate, latest)).toBe(true);
    expect(alignFutureActionDayReferences(candidate, latest)).toBe(expected);
  });

  it('does not reinterpret the date inside a requested future message draft', () => {
    const request = '明日の朝、相手に伝える文面を一つだけ考えてください。';
    const candidate = '明日の朝、今日行う作業を一つ紙に書いてください。';
    expect(containsAmbiguousFutureActionDayReference(candidate, request)).toBe(false);
    expect(alignFutureActionDayReferences(candidate, request)).toBe(candidate);
  });

  it('preserves the user distinction when it was supplied in current user history', () => {
    const currentUserTexts = ['今日行う作業は資料の確認です。', latest];
    expect(containsAmbiguousFutureActionDayReference(observed, latest, currentUserTexts)).toBe(false);
    expect(alignFutureActionDayReferences(observed, latest, currentUserTexts)).toBe(observed);
    expect(normalizeCoachingOutput(observed, latest, [{ role: 'user', content: currentUserTexts[0] }])).toBe(observed);
  });

  it('does not treat an explicit rejection of today as support for today', () => {
    const request = '今日ではなく、明日の朝に始める行動を一つだけ、質問なしで答えてください。';
    expect(containsAmbiguousFutureActionDayReference(observed, request)).toBe(true);
    expect(alignFutureActionDayReferences(observed, request)).toBe(alignedObserved);
  });

  it('does not rewrite an independent today statement before a tomorrow action', () => {
    const candidate = '今日行う作業はまだ決めていません。明日の朝、用事を一つ紙に書いてください。';
    // Scope protection does not endorse that separate factual statement.
    expect(containsAmbiguousFutureActionDayReference(candidate, latest)).toBe(false);
    expect(alignFutureActionDayReferences(candidate, latest)).toBe(candidate);
  });

  it.each([
    '明日の朝、今日の作業を振り返ってください。',
    '明日の朝、本日の仕事を思い出してください。',
    '明日の朝、今日の作業を一つだけ振り返ってください。',
    '明日の朝、本日の仕事をひとつだけ思い出してください。',
    '明日の朝、今日の作業を1つだけ振り返ってください。',
    '明日の朝、今日の仕事を少しだけ振り返ってください。',
  ])('keeps an explicit retrospective instruction in the temporal helper: %s', (candidate) => {
    expect(containsAmbiguousFutureActionDayReference(candidate, latest)).toBe(false);
    expect(alignFutureActionDayReferences(candidate, latest)).toBe(candidate);
  });

  it('rejects the exact public ambiguity in the real smoke assertions', () => {
    expect(() => assertSmokeResults([smokeResult(observed)])).toThrow(/day|time reference/);
  });

  it('accepts the same concrete action with an explicit execution-day target in smoke', () => {
    expect(() => assertSmokeResults([smokeResult(alignedObserved)])).not.toThrow();
  });

  it('rejects the exact public ambiguity in the real standard evaluator', () => {
    expect(evaluatorChecks(observed).find(check => check.name.endsWith(': 明日の行動対象日を今日と曖昧にしない'))?.passed).toBe(false);
  });

  it('accepts the explicit execution-day target in the real standard evaluator', () => {
    expect(evaluatorChecks(alignedObserved).find(check => check.name.endsWith(': 明日の行動対象日を今日と曖昧にしない'))?.passed).toBe(true);
  });
});


// Captured public R1/R3 bodies. Test day-span helpers independently from
// whole-pipeline grounding repair, which may replace an unsupported task target.
const observedDayModifierActuals = [
  { name:'a871-r1-parallel-burst-1-1', latest:'同時接続テスト1です。明日の朝に始める行動を一つだけ、質問なしで答えてください。', candidate:'明日の朝起きたら、今日行う予定の作業を一つノートに書き出してください。', expected:'明日の朝起きたら、その日に行う予定の作業を一つノートに書き出してください。' },
  { name:'a871-r3-parallel-burst-5-1', latest:'同時接続テスト5です。明日の朝に始める行動を一つだけ、質問なしで答えてください。', candidate:'明日の朝、朝起きたら、今日一番優先して進めたい作業をノートに一つ書いてください。', expected:'明日の朝、朝起きたら、その日に一番優先して進めたい作業をノートに一つ書いてください。' },
] as const;
const observedDayModifierSeen:unknown[]=[];
afterAll(()=>{const output=process.env.ACTI_OBSERVED_DAY_MODIFIER_REPLAY_OUTPUT;if(output)writeFileSync(output,JSON.stringify({scope:'Two existing actual public bodies, helper-only date contract',providerOriginal:'NOT_CAPTURED',newLiveCases:0,actuals:observedDayModifierSeen},null,2)+'\n',{flag:'wx',mode:0o600});});
describe('observed task modifiers retain explicit future execution day',()=>{
  it.each(observedDayModifierActuals)('$name',item=>{
    const detected=containsAmbiguousFutureActionDayReference(item.candidate,item.latest,[item.latest]);
    const aligned=alignFutureActionDayReferences(item.candidate,item.latest,[item.latest]);
    observedDayModifierSeen.push({...item,history:[],detected,aligned});
    expect(detected).toBe(true);expect(aligned).toBe(item.expected);
  });
});
