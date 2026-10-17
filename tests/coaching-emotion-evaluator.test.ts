import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
import { containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference, containsShorteningActionTimeMismatch } from '../src/lib/coaching-action-language.mjs';

const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  seededContinuityScenarios, evaluateSeededContinuityResponse: () => [], containsDeadlineOutcomeAssurance,
  containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference, containsShorteningActionTimeMismatch,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});

function turnChecks(message: string, user: string, number = 2) {
  return evaluate([{ name: 'explicit-deeper-question', turns: [{ user,
    label: `explicit-deeper-question-${number}`, message, rawMessage: message, status: 200, hasDone: true,
    completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'STOP', firstChunkMs: 100,
    totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] }] }]).checks as { name: string; passed: boolean }[];
}

function emotionCheck(message: string, user = '条件の一覧より、自分がなぜ迷うのかを話したいです。') {
  return turnChecks(message, user).find(check => check.name.includes('迷いへ未提示の強い感情'))!;
}

describe('standard deeper-question scenario emotion grounding', () => {
  it.each([
    '心がかき乱される理由を理解することが、あなたにとって納得のいく判断につながります。',
    'あなたは激しく動揺しているのですね。',
    '心が乱れる理由は何ですか？',
    '上司に「心がかき乱されています」と伝えてください。',
  ])('fails an invented state despite successful numeric response metadata: %s', message => {
    expect(emotionCheck(message).passed).toBe(false);
  });
  it.each([
    'なぜ迷うのかを話したいのですね。役割を引き受けると思った時、最初に頭に浮かんだ考えは何ですか？',
    '心が乱れますか？',
    'もし心がかき乱されることがあれば、その時の考えを聞かせてください。',
    '心がかき乱されているとは決めつけません。',
  ])('keeps ordinary introspection, questions, hypothetical and negation: %s', message => {
    expect(emotionCheck(message).passed).toBe(true);
  });
  it('uses the user report rather than assuming the fixed scenario can never mention strong emotion', () => {
    expect(emotionCheck('心がかき乱されているのですね。', '心がかき乱されています。').passed).toBe(true);
  });
  it.each([
    ['もう少し深く、あなたが迷っている理由を聞いてほしいのですね。迷う理由をこちらで決めず、あなた自身の考えを出発点にします。', false],
    ['もう少し深く、あなたが迷っている理由を聞いてほしいのですね。引き受ける場合も断る場合も、後悔したくないことは何ですか？', true],
  ])('requires the requested substantive question at turn three: %s', (message, expected) => {
    expect(turnChecks(message as string, '定型的な整理ではなく、もう少し深く聞いてほしいです。', 3)
      .find(check => check.name.includes('明示された深掘り希望'))?.passed).toBe(expected);
  });
  it('does not add public scenarios or change the independent population specification', () => {
    expect(source).toContain('conversations: 28, turns: 56');
    expect(seededContinuityScenarios).toHaveLength(7);
  });
});
