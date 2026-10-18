import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference, containsShorteningActionTimeMismatch } from '../src/lib/coaching-action-language.mjs';

const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  seededContinuityScenarios, evaluateSeededContinuityResponse: () => [],
  containsUnsupportedConcernPremise, currentTopicUserTexts, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference, containsShorteningActionTimeMismatch,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});

// Saved public/done metadata from the synthetic long-continuity turn two as the
// legacy pipeline delivered it: a retry notice (`local-quality-fallback`) that
// kept the upstream provider's `completed` finish reason. The upstream
// candidate and identity were not retained in that report.
const observedRetryNotice = {
  label: 'long-continuity-three-turn-reference-2', user: '対象は初めてサービスを使う人です。',
  message: '企画の説明資料を読むのは、初めてサービスを使う人なのですね。読者が仕組みや用語を知っている前提を置かず、「何ができるか」「最初に何をするか」の順で説明すると理解しやすくなります。機能をすべて紹介する前に、読者が最初に達成したいことを決めると、必要な説明を選べます。\n\nその資料を読んだ人に、まず何ができるようになってほしいですか？',
  status: 200, firstChunkMs: 7472, totalMs: 7510, hasDone: true,
  completionStatus: 'complete', finalizationStatus: 'complete', finishReason: 'completed',
  modelName: 'local-quality-fallback', provider: 'local', qualityInitialIssues: ['context_mismatch'], qualityFinalIssues: [],
};
// The same body as the safety-only pipeline delivers it: the model's own text,
// with the quality finding kept in telemetry only.
const aiReply = { ...observedRetryNotice, finishReason: 'STOP', modelName: 'gemini-3.5-flash', provider: null };

const AI_REPLY_CHECK = ': AIの応答を使用（ローカル固定文ではない）';
const FINISH_CHECK = ': 生成が正常終了';
const SAFETY_HOLD_CHECK = ': 安全ホールドによる差し替えなし';
const LOCAL_RUN_CHECK = '可用性: ローカル固定文の応答は0件';
const EXTERNAL_RUN_CHECK = '可用性: 外部フォールバックは0件';

function checkPassed(turn: Record<string, unknown>, suffix: string, overrides: Record<string, unknown> = {}) {
  const candidate = { ...turn, rawMessage: turn.message, outputChars: String(turn.message).length, ...overrides };
  return evaluate([{ name: 'long-continuity-three-turn-reference', turns: [candidate] }]).checks
    .find((check: { name: string }) => check.name.endsWith(suffix))?.passed;
}

describe('safety-only pipeline: only AI provider replies count as healthy turns', () => {
  it('rejects the captured retry notice even though its stream completed cleanly', () => {
    expect(checkPassed(observedRetryNotice, AI_REPLY_CHECK)).toBe(false);
    expect(checkPassed(observedRetryNotice, LOCAL_RUN_CHECK)).toBe(false);
  });
  it.each(['local-topic-recovery', 'local-rest', 'local-long-history-action', 'local-morning-preparation', 'local-fallback'])(
    'rejects every other local fixed reply too: %s', modelName => {
      expect(checkPassed(aiReply, AI_REPLY_CHECK, { modelName, provider: 'local' })).toBe(false);
      expect(checkPassed(aiReply, LOCAL_RUN_CHECK, { modelName, provider: 'local' })).toBe(false);
    });
  it('rejects a LOCAL_* finish reason even when the provider field is missing', () => {
    expect(checkPassed(aiReply, AI_REPLY_CHECK, { finishReason: 'LOCAL_TOPIC_RECOVERY', provider: undefined })).toBe(false);
    expect(checkPassed(aiReply, FINISH_CHECK, { finishReason: 'LOCAL_TOPIC_RECOVERY' })).toBe(false);
  });
  it('accepts the same body when the model itself delivered it', () => {
    expect(checkPassed(aiReply, AI_REPLY_CHECK)).toBe(true);
    expect(checkPassed(aiReply, LOCAL_RUN_CHECK)).toBe(true);
    expect(checkPassed(aiReply, FINISH_CHECK)).toBe(true);
    expect(checkPassed(aiReply, SAFETY_HOLD_CHECK)).toBe(true);
  });
  it('treats a missing provider as the primary Gemini reply', () => {
    expect(checkPassed(aiReply, AI_REPLY_CHECK, { provider: undefined })).toBe(true);
  });
  it.each([
    { provider: 'openai', finishReason: 'completed' },
    { provider: 'anthropic', finishReason: 'end_turn' },
  ])('accepts a recovered external fallback per turn but still reports it at run level: %j', override => {
    expect(checkPassed(aiReply, AI_REPLY_CHECK, override)).toBe(true);
    expect(checkPassed(aiReply, FINISH_CHECK, override)).toBe(true);
    expect(checkPassed(aiReply, EXTERNAL_RUN_CHECK, override)).toBe(false);
  });
  it.each(['STOP', 'completed', 'end_turn'])('keeps the successful provider reason %s', finishReason => {
    expect(checkPassed(aiReply, FINISH_CHECK, { finishReason })).toBe(true);
  });
  it.each(['MAX_TOKENS', 'unknown', 'incomplete', 'failed'])('rejects the unsuccessful or unknown reason %s', finishReason => {
    expect(checkPassed(aiReply, FINISH_CHECK, { finishReason })).toBe(false);
  });
  it('fails a turn the safety hold replaced', () => {
    expect(checkPassed(aiReply, SAFETY_HOLD_CHECK, { qualitySafetyHold: true })).toBe(false);
  });
  it.each([
    { override: { completionStatus: 'partial' }, suffix: ': AI生成が完全完了' },
    { override: { finalizationStatus: 'failed' }, suffix: ': 会話後処理が完全完了' },
    { override: { finalizationStatus: 'pending' }, suffix: ': 会話後処理が完全完了' },
    { override: { qualityFinalIssues: ['context_mismatch'] }, suffix: ': 表示前の安全検品を通過' },
  ])('still fails an incomplete or unverified AI turn: $override', ({ override, suffix }) => {
    expect(checkPassed(aiReply, suffix, override)).toBe(false);
  });
});
