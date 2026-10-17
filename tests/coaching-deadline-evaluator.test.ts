import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
import { containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference } from '../src/lib/coaching-action-language.mjs';
const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  seededContinuityScenarios, evaluateSeededContinuityResponse: () => [],
  containsDeadlineOutcomeAssurance,
  containsUnsupportedConcernPremise, currentTopicUserTexts, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
function deadlineChecks(message: string, number = 7) {
  return evaluate([{ name: 'long-continuity-three-turn-reference', turns: [{ label: `long-continuity-three-turn-reference-${number}`,
    message, rawMessage: message, status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP',
    firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] }] }]).checks
    .filter((check: { name: string }) => /未確認の作業時間|伝えた締切|最初に直す一箇所/.test(check.name)) as { name: string; passed: boolean }[];
}
describe('standard long-continuity deadline semantic gates', () => {
  it.each([
    '火曜午前10時の期限には、骨組みがあれば十分間に合います。',
    '火曜午前10時には必ず間に合います。',
    '担当者に「火曜午前10時までに必ず間に合います」と伝えてください。',
    '火曜午前10時には間に合いますとは限りませんが、この骨組みなら必ず間に合います。',
    'この構成なら火曜午前10時の締切までに予定通り提出できます。',
    'この骨組みがあれば火曜午前10時の期限までに仕上げられます。',
    '今から始めれば火曜午前10時の期日までに完了できます。',
    'この手順なら火曜午前10時の締切までに間に合うはずだ。',
    'これだけ直せば火曜午前10時の期限に間に合わせられます。',
    '火曜午前10時の締切ですね。骨組みがあれば、予定通り提出できます。',
  ])('fails an unsupported assurance despite clean numeric quality metadata: %s', message => {
    const checks = deadlineChecks(message); expect(checks).toHaveLength(2); expect(checks.some(check => !check.passed)).toBe(true);
  });
  it.each([
    '資料の期限は火曜午前10時なのですね。間に合うかは資料の進み具合と使える時間を確認しないと判断できません。',
    '資料の締切は火曜午前10時ですね。期限までに間に合いそうですか？',
    '資料の締切は火曜午前10時ですね。期限までに間に合うでしょうか？',
    '火曜午前10時の締切に向けて、資料の利用目的を一文に絞ってください。',
  ])('preserves uncertainty, feasibility questions and goals: %s', message => {
    expect(deadlineChecks(message).every(check => check.passed)).toBe(true);
  });
  it.each(['金曜午後3時の締切に向けて、一枚目の利用目的を見直してください。', '一枚目の利用目的を見直してください。'])('fails an incorrect or lost supplied deadline: %s', message => {
    expect(deadlineChecks(message, 10).some(check => !check.passed)).toBe(true);
  });
  it('requires a concrete first target without returning another question at turn ten', () => {
    const message = '火曜午前10時の締切に向けて、今日最初に直すのは一枚目の利用目的です。利用目的を一文に絞ってください。';
    expect(deadlineChecks(message, 10)).toHaveLength(3);
    expect(deadlineChecks(message, 10).every(check => check.passed)).toBe(true);
    expect(deadlineChecks('火曜午前10時ですね。どこから始めますか？', 10).some(check => !check.passed)).toBe(true);
  });
  for (const number of [7, 10]) {
    it.each(['火曜日午前10時', '火曜午前１０時', '火曜午前10時0分'])('preserves equivalent time notation at turn '+number+': %s', time => {
      expect(deadlineChecks(`${time}の締切に向けて、一枚目の利用目的を一文にまとめてください。`, number).every(check => check.passed)).toBe(true);
    });
    it('rejects an actually different time at turn '+number, () => {
      expect(deadlineChecks('火曜午前11時の締切に向けて、一枚目の利用目的を一文にまとめてください。', number)
        .find(check => check.name.includes('伝えた締切'))?.passed).toBe(false);
    });
  }
  it('retains the independent population contract without adding scenarios', () => {
    expect(source).toContain('conversations: 28, turns: 56');
    expect(seededContinuityScenarios).toHaveLength(7);
  });
});
