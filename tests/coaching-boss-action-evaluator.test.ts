import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsCircularSingleAction, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference } from '../src/lib/coaching-action-language.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  seededContinuityScenarios, evaluateSeededContinuityResponse, containsDeadlineOutcomeAssurance,
  containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts, containsCircularSingleAction, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
function turn(user: string, message: string, label: string) {
  return { user, message, rawMessage: message, label, status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete',
    finishReason: 'STOP', firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] };
}

const fear = '上司に否定されたように感じて、次の一言が怖いです。';
const badBoss = '上司に否定されたように感じ、次に何を言ってもまた否定されるのではないかと、言葉を出す前に止まっているのですね。';
const badHome = '家で今いちばん止まっている出来事を、一つだけ具体的に教えてください。';
const actionUser = '同時接続テスト1です。明日の朝に始める行動を一つだけ、質問なしで答えてください。';
const badTask = '明日の朝一番に、今日残した作業のリストを1つ確認してください。';
const positiveTask = '明日の朝、終わらせたい用事を一つだけ紙に書いてください。';
function passed(user: string, message: string, ending: string, seedHistory: {role:string;content:string}[] = []) {
  return evaluate([{name:'finite-existing-observation',seedHistory,turns:[turn(user,message,'actual')]}]).checks
    .find((check:{name:string}) => check.name.endsWith(ending))?.passed;
}
describe('finite situation and task grounding in standard evaluation', () => {
  it('rejects the observed boss stopped-speech premise', () => {
    expect(passed(fear,badBoss,'本人未申告の停止状況や実指摘を前提にしない')).toBe(false);
  });
  it('rejects the observed home stalled-event premise after a topic switch', () => {
    expect(passed('仕事の整理はできました。今度は家での相談です。',badHome,'本人未申告の停止状況や実指摘を前提にしない')).toBe(false);
  });
  it('rejects the observed assumed leftover-work list', () => {
    expect(passed(actionUser,badTask,'本人未申告の残作業を前提にしない')).toBe(false);
  });
  it('keeps the existing paper action without assuming an artifact', () => {
    expect(passed(actionUser,positiveTask,'本人未申告の残作業を前提にしない')).toBe(true);
  });
  it('keeps a leftover-work list actually stated by the user', () => {
    expect(passed(actionUser,badTask,'本人未申告の残作業を前提にしない',[{role:'user',content:'今日残した作業のリストを作りました。'}])).toBe(true);
  });
  it('does not use an AI statement as evidence of that list', () => {
    expect(passed(actionUser,badTask,'本人未申告の残作業を前提にしない',[{role:'assistant',content:'今日残した作業のリストがあるのですね。'}])).toBe(false);
  });
});
