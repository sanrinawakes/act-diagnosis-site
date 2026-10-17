import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference, containsShorteningActionTimeMismatch } from '../src/lib/coaching-action-language.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  seededContinuityScenarios, evaluateSeededContinuityResponse, containsDeadlineOutcomeAssurance,
  containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference, containsShorteningActionTimeMismatch,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
function turn(user: string, message: string, label: string) {
  return { user, message, rawMessage: message, label, status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete',
    finishReason: 'STOP', firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] };
}
const docUser = '専門用語を減らしたいです。';
const docBad = '専門用語を減らして、初めて使う人にわかりやすく伝えたいのですね。専門用語を日常で使う言葉や具体的な動作に置き換えると、読者が途中でつまずかずに読み進められます。\n\n資料の中で、特にどの言葉の言い換えに迷っていますか？';
const docEarlier = [turn('新しい企画の説明資料を作っています。', '説明資料を作っているのですね。', 'doc-1'),
  turn('対象は初めてサービスを使う人です。', '初めて使う人向けなのですね。', 'doc-2')];
function concernCheck(conversation: { name: string; turns: ReturnType<typeof turn>[]; seedHistory?: { role: string; content: string }[] }, label: string) {
  return evaluate([conversation]).checks.find((check: { name: string }) => check.name === `${label}: 本人未申告の迷い・不安・持続的な気掛かりや生活影響を前提にしない`)?.passed;
}
describe('standard evaluator shares current user concern grounding', () => {
  const shortReplyEarlier = [
    turn('友人に断りたい予定があるのに、返事を先延ばしにしています。', '友人への返事について、いま一番話したいことは何ですか？', 'short-reply-continuation-1'),
    turn('断ると関係が悪くなる気がします。', '友人に断りの連絡を入れるとしたら、どのような返事を予想していますか？', 'short-reply-continuation-2'),
  ];
  const wordingClaim = '予想される反応を考えると、送る文面にも迷いますね。';
  it('rejects polite-form indecision inferred from the original weak agreement', () => {
    expect(concernCheck({ name: 'short-reply-continuation', turns: [...shortReplyEarlier,
      turn('そうかも。', wordingClaim, 'short-reply-continuation-3')] }, 'short-reply-continuation-3')).toBe(false);
  });
  it('does not use a later own report to justify the earlier polite-form assertion', () => {
    expect(concernCheck({ name: 'short-reply-continuation', turns: [...shortReplyEarlier,
      turn('そうかも。', wordingClaim, 'short-reply-continuation-3'),
      turn('送る文面に迷います。', wordingClaim, 'short-reply-continuation-4')] }, 'short-reply-continuation-3')).toBe(false);
  });
  it('preserves the polite form once the current user actually reports indecision', () => {
    expect(concernCheck({ name: 'short-reply-continuation', turns: [...shortReplyEarlier,
      turn('送る文面に迷います。', wordingClaim, 'short-reply-continuation-3')] }, 'short-reply-continuation-3')).toBe(true);
  });
  it('rejects the actual doc premise despite otherwise clean metadata', () => {
    expect(concernCheck({ name: 'long-continuity-three-turn-reference', turns: [...docEarlier, turn(docUser, docBad, 'doc-3')] }, 'doc-3')).toBe(false);
  });
  it('does not use a later user report retroactively', () => {
    expect(concernCheck({ name: 'long-continuity-three-turn-reference', turns: [...docEarlier, turn(docUser, docBad, 'doc-3'),
      turn('説明する順番にも迷っています。', '順番に迷っているのですね。', 'doc-4')] }, 'doc-3')).toBe(false);
  });
  it('keeps a concern once the user actually states it', () => {
    expect(concernCheck({ name: 'long-continuity-three-turn-reference', turns: [...docEarlier,
      turn('説明する順番にも迷っています。', '説明する順番に迷っているのですね。', 'doc-4')] }, 'doc-4')).toBe(true);
  });
  it('does not take an assistant seed as user-state evidence', () => {
    expect(concernCheck({ name: 'doc', seedHistory: [{role:'assistant',content:'言い換えに迷っているのですね。'}], turns:[turn(docUser,docBad,'doc-3')] },'doc-3')).toBe(false);
  });
  it('uses an actual user seed, but honors its later negation', () => {
    const seedHistory = [{role:'user',content:'言い換えに迷っています。'}];
    expect(concernCheck({name:'doc',seedHistory,turns:[turn(docUser,docBad,'doc-3')]},'doc-3')).toBe(true);
    expect(concernCheck({name:'doc',seedHistory,turns:[turn('今は迷っていません。専門用語を減らしたいです。',docBad,'doc-3')]},'doc-3')).toBe(false);
  });
  it('does not carry a concern across an explicit topic boundary', () => {
    expect(concernCheck({name:'doc',seedHistory:[{role:'user',content:'言い換えに迷っています。'}],
      turns:[turn('話題を変えて、資料の専門用語を減らしたいです。',docBad,'doc-3')]},'doc-3')).toBe(false);
  });
  it('keeps the neutral doc question instead of requiring a concern', () => {
    expect(concernCheck({name:'doc',turns:[...docEarlier,turn(docUser,'今の資料で、まず言い換えたい専門用語は何ですか？','doc-3')]},'doc-3')).toBe(true);
  });
  it('rejects the same observed service premise in the shared seeded evaluation', () => {
    expect(evaluateSeededContinuityResponse('seeded-actor-particle-is-not-a-reason',
      'お客様から予約キャンセルの連絡を受けたことについて、どのような対応で迷っていますか？')
      .some(check => !check.passed)).toBe(true);
  });
});
describe('standard action evaluation checks more than length and one move', () => {
  const user = '同時接続テスト4です。明日の朝に始める行動を一つだけ、質問なしで答えてください。';
  const actionPass = (message: string) => evaluate([{name:'parallel-burst-4',turns:[turn(user,message,'parallel-burst-4-1')]}]).checks
    .find((check:{name:string}) => check.name.endsWith(': 作業の開始を言い換えるだけでなく具体動作を示す'))?.passed;
  it('rejects the observed circular imperative', () => {
    expect(actionPass('明日の朝、最初に行う作業に一つだけ着手してください。')).toBe(false);
  });
  it('keeps the existing concrete paper action', () => {
    expect(actionPass('明日の朝、終わらせたい用事を一つだけ紙に書いてください。')).toBe(true);
  });
});

describe('standard evaluator keeps persistent impact grounded in earlier user reports', () => {
  const user = '友人に断りたい予定があるのに、返事を先延ばしにしています。';
  const candidate = '断りたい予定があるのに返事を先延ばしにしていると、ずっと頭のどこかで気になって過ごしづらいですよね。\n\n断った後の友人との関係が気になって、返事を送るのが難しくなっていますか？';
  it('rejects the captured assertion even when stream metadata is clean', () => {
    expect(concernCheck({ name: 'short-reply-continuation', turns: [turn(user, candidate, 'short-1')] }, 'short-1')).toBe(false);
  });
  it('keeps both impacts when the user actually reports both', () => {
    const supported = 'ずっと頭のどこかで気になって過ごしづらいです。友人への返事を先延ばしにしています。';
    expect(concernCheck({ name: 'short-reply-continuation', turns: [turn(supported, candidate, 'short-1')] }, 'short-1')).toBe(true);
  });
  it('does not use a later reported impact to justify the earlier assertion', () => {
    expect(concernCheck({ name: 'short-reply-continuation', turns: [turn(user, candidate, 'short-1'),
      turn('ずっと頭のどこかで気になって過ごしづらいです。', 'その状態なのですね。', 'short-2')] }, 'short-1')).toBe(false);
  });
});
