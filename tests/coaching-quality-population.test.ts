import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsCircularSingleAction, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption } from '../src/lib/coaching-action-language.mjs';

const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specificationStart = source.indexOf('const BASELINE_QUALITY_POPULATION =');
const specification = specificationStart < 0 ? '' : source.slice(specificationStart, source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
// Execute the actual evaluator and population specification only. Stubs below
// cover unrelated quality/availability checks; no top-level client is imported.
const api = vm.runInNewContext(`${specification}\n${evaluation}\n({ evaluateConversations,
  expected: typeof EXPECTED_QUALITY_POPULATION === 'undefined' ? null : EXPECTED_QUALITY_POPULATION })`, {
  seededContinuityScenarios,
  evaluateSeededContinuityResponse: () => [],
  containsUnsupportedConcernPremise, currentTopicUserTexts, containsCircularSingleAction, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }),
  countCoachingMoves: () => 0,
  addCheck: (checks: Record<string, unknown>[], name: string, passed: boolean, details?: unknown) => checks.push({ name, passed, details }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '',
  maxFirstChunkMs: 10000, maxTotalMs: 15000,
});

const turn = (label: string) => ({
  label, message: 'Synthetic response.', rawMessage: 'Synthetic response.',
  status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete',
  finishReason: 'STOP', firstChunkMs: 100, totalMs: 1000, outputChars: 100,
  qualityInitialIssues: [], qualityFinalIssues: [],
});
const population = () => [
  ...Array.from({ length: 28 }, (_, index) => ({ name: `baseline-${index}`, seedHistory: [],
    turns: [turn(`baseline-${index}-1`), turn(`baseline-${index}-2`)] })),
  ...seededContinuityScenarios.map((scenario) => ({ name: scenario.name, seedHistory: scenario.seedHistory,
    turns: scenario.inputs.map((_, index) => turn(`${scenario.name}-${index + 1}`)) })),
];
const checks = (conversations: ReturnType<typeof population>) => api.evaluateConversations(conversations).checks
  .filter((check: { name: string }) => check.name.startsWith('比較母集団:')) as { name: string; passed: boolean; details: string }[];

describe('standard quality evaluation population specification', () => {
  it('uses the fixed 28/56 baseline plus the seven declared generated inputs', () => {
    expect(api.expected).toEqual({ conversations: 35, turns: 63 });
    const result = checks(population());
    expect(result).toHaveLength(3);
    expect(result.every((check) => check.passed)).toBe(true);
    expect(result.some((check) => check.name === '比較母集団: 35会話')).toBe(true);
    expect(result.some((check) => check.name === '比較母集団: 63ターン')).toBe(true);
  });

  it('fails if one baseline conversation is omitted', () => {
    expect(checks(population().slice(1)).some((check) => !check.passed)).toBe(true);
  });

  it.each([-1, 1])('fails if a generated turn differs from the fixed specification: %s', (delta) => {
    const actual = population();
    if (delta < 0) actual[0].turns.pop();
    else actual[0].turns.push(turn('unexpected-extra-turn'));
    expect(checks(actual).some((check) => !check.passed)).toBe(true);
  });

  it('fails if one seeded conversation is replaced by a duplicate with equal total counts', () => {
    const actual = population(); actual[29] = { ...actual[28], turns: [...actual[28].turns] };
    expect(checks(actual).some((check) => !check.passed)).toBe(true);
  });

  it('fails a baseline duplicate replacing another baseline at the same total counts', () => {
    const actual = population(); actual[1] = { ...actual[0], turns: [...actual[0].turns] };
    expect(checks(actual).some((check) => !check.passed)).toBe(true);
  });

  it('fails an unplanned empty conversation even while generated turns remain 63', () => {
    const actual = population(); actual.push({ name: 'unexpected-empty', seedHistory: [], turns: [] });
    expect(checks(actual).some((check) => !check.passed)).toBe(true);
  });

  it('does not count seeded history or memory preload as newly generated turns', () => {
    const actual = population(); actual[0].seedHistory = Array.from({ length: 160 }, () => ({ role: 'user', content: 'Synthetic previous turn.' }));
    expect(checks(actual).every((check) => check.passed)).toBe(true);
  });

  it('fails a shifted seeded turn label instead of relying on equal totals', () => {
    const actual = population(); actual[28].turns[0].label = 'unexpected-seeded-1';
    expect(checks(actual).some((check) => !check.passed)).toBe(true);
  });
});
