import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsCircularSingleAction, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption } from '../src/lib/coaching-action-language.mjs';

const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  seededContinuityScenarios, evaluateSeededContinuityResponse: () => [],
  containsUnsupportedConcernPremise, currentTopicUserTexts, containsCircularSingleAction, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});

// Saved public/done metadata from the synthetic long-continuity turn two. The
// upstream provider candidate and identity were not retained in that report.
const observedTurn = {
  label: 'long-continuity-three-turn-reference-2', user: '対象は初めてサービスを使う人です。',
  message: '企画の説明資料を読むのは、初めてサービスを使う人なのですね。読者が仕組みや用語を知っている前提を置かず、「何ができるか」「最初に何をするか」の順で説明すると理解しやすくなります。機能をすべて紹介する前に、読者が最初に達成したいことを決めると、必要な説明を選べます。\n\nその資料を読んだ人に、まず何ができるようになってほしいですか？',
  status: 200, firstChunkMs: 7472, totalMs: 7510, hasDone: true,
  completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'completed',
  modelName: 'local-quality-fallback', provider: 'local', qualityInitialIssues: ['context_mismatch'], qualityFinalIssues: [],
};
function terminationPassed(overrides: Record<string, unknown> = {}) {
  const turn = { ...observedTurn, rawMessage: observedTurn.message, outputChars: observedTurn.message.length, ...overrides };
  return evaluate([{ name: 'long-continuity-three-turn-reference', turns: [turn] }]).checks
    .find((check: { name: string }) => check.name.endsWith(': 生成が正常終了'))?.passed;
}

describe('verified local recovery preserves provider completion vocabulary', () => {
  it('accepts the actual completed/local successful recovery without rewriting its reason', () => {
    expect(terminationPassed()).toBe(true);
    expect(observedTurn.finishReason).toBe('completed');
  });
  it.each(['STOP', 'end_turn'])('keeps the existing successful reason %s', finishReason => {
    expect(terminationPassed({ finishReason })).toBe(true);
  });
  it.each(['MAX_TOKENS', 'unknown', 'incomplete', 'failed'])('rejects the unsuccessful or unknown reason %s', finishReason => {
    expect(terminationPassed({ finishReason })).toBe(false);
  });
  it.each([
    { completionStatus: 'partial' },
    { finalizationStatus: 'failed' },
    { finalizationStatus: 'pending' },
    { qualityFinalIssues: ['context_mismatch'] },
    { provider: 'openai' },
    { modelName: 'unverified-recovery' },
    { expectedFinishReason: 'LOCAL_REST_RESPONSE' },
  ])('does not excuse an unverified completed response: %j', override => {
    expect(terminationPassed(override)).toBe(false);
  });
});
