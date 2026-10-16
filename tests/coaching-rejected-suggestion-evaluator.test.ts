import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import * as quotation from '../src/lib/coaching-quotation-language.mjs';

// The target check executes from the actual evaluator source and map wiring.
// Other quality checks are stubbed; this does not assert their correctness.
const source = readFileSync(resolve('scripts/evaluate-coaching-quality.mjs'), 'utf8');
const snapshot = JSON.parse("{\"name\": \"rejected-suggestion-and-direct-answer\", \"diagnosisCode\": \"MME-3\", \"sessionId\": \"45cf4e5f-0a04-4b2b-bf2a-9718e0db62b8\", \"seedHistory\": [], \"turns\": [{\"user\": \"家賃は76000円ですが、夫は毎月20000円くらいしか払わず、私が不足分を負担しています。毎月全額払ってほしいです。\", \"label\": \"rejected-suggestion-and-direct-answer-1\", \"status\": 200, \"firstChunkMs\": 2541, \"doneMs\": 2541, \"totalMs\": 2541, \"hasDone\": true, \"completionStatus\": \"complete\", \"finalizationStatus\": \"complete\", \"finishReason\": \"STOP\", \"modelName\": \"gemini-3.5-flash\", \"provider\": null, \"qualityRepairAttempted\": false, \"qualityRepairAccepted\": false, \"qualityInitialIssues\": [\"too_short\"], \"qualityFinalIssues\": [], \"expectedModelName\": \"\", \"expectedFinishReason\": \"\", \"usage\": {\"prompt_tokens\": 5037, \"completion_tokens\": 47, \"thoughts_tokens\": 252, \"total_tokens\": 5336}, \"outputChars\": 126, \"questionMarks\": 1, \"semanticQuestions\": 1, \"rawMessage\": \"家賃76,000円のうち、ご主人の支払いが約20,000円で、毎月およそ56,000円を自分が負担しているのですね。希望する負担額とは別に、二人で合意できている内容があるかを確認できます。\\n\\n家賃の負担について、ご主人からどのような返答がありましたか？\", \"message\": \"家賃76,000円のうち、ご主人の支払いが約20,000円で、毎月およそ56,000円を自分が負担しているのですね。希望する負担額とは別に、二人で合意できている内容があるかを確認できます。\\n\\n家賃の負担について、ご主人からどのような返答がありましたか？\"}, {\"user\": \"夫には毎月、家賃を全額払ってほしいと伝えています。それでも払われません。\", \"label\": \"rejected-suggestion-and-direct-answer-2\", \"status\": 200, \"firstChunkMs\": 1551, \"doneMs\": 1551, \"totalMs\": 1551, \"hasDone\": true, \"completionStatus\": \"complete\", \"finalizationStatus\": \"complete\", \"finishReason\": \"STOP\", \"modelName\": \"gemini-3.5-flash\", \"provider\": null, \"qualityRepairAttempted\": false, \"qualityRepairAccepted\": false, \"qualityInitialIssues\": [\"too_short\"], \"qualityFinalIssues\": [], \"expectedModelName\": \"\", \"expectedFinishReason\": \"\", \"usage\": {\"prompt_tokens\": 5140, \"completion_tokens\": 37, \"total_tokens\": 5177}, \"outputChars\": 93, \"questionMarks\": 1, \"semanticQuestions\": 1, \"rawMessage\": \"毎月、家賃を全額払ってほしいと伝えても支払いが変わらないのですね。伝えた希望が、そのまま相手との合意になったとは限りません。\\n\\n支払い分担について、これまで二人で決めたことはありますか？\", \"message\": \"毎月、家賃を全額払ってほしいと伝えても支払いが変わらないのですね。伝えた希望が、そのまま相手との合意になったとは限りません。\\n\\n支払い分担について、これまで二人で決めたことはありますか？\"}, {\"user\": \"その伝え方はもう毎月やっています。同じ提案や同じ質問はしないでください。\", \"label\": \"rejected-suggestion-and-direct-answer-3\", \"status\": 200, \"firstChunkMs\": 304, \"doneMs\": 313, \"totalMs\": 316, \"hasDone\": true, \"completionStatus\": \"complete\", \"finalizationStatus\": \"complete\", \"finishReason\": \"LOCAL_TOPIC_RECOVERY\", \"modelName\": \"local-topic-recovery\", \"provider\": \"local\", \"qualityRepairAttempted\": false, \"qualityRepairAccepted\": false, \"qualityInitialIssues\": [], \"qualityFinalIssues\": [], \"expectedModelName\": \"local-topic-recovery\", \"expectedFinishReason\": \"LOCAL_TOPIC_RECOVERY\", \"usage\": {}, \"outputChars\": 135, \"questionMarks\": 0, \"semanticQuestions\": 0, \"rawMessage\": \"前の返答では、毎月すでに伝えていることを踏まえられていませんでした。申し訳ありません。家賃の支払い不足が続くなら、言い方を変える提案は繰り返しません。まず直近3か月の家賃額、相手の支払額、不足額を記録してください。実際の支払いの記録が、今後の対応を考える材料になります。\", \"message\": \"前の返答では、毎月すでに伝えていることを踏まえられていませんでした。申し訳ありません。家賃の支払い不足が続くなら、言い方を変える提案は繰り返しません。まず直近3か月の家賃額、相手の支払額、不足額を記録してください。実際の支払いの記録が、今後の対応を考える材料になります。\"}, {\"user\": \"わからないから聞いています。質問を返さず、今までと違う対応を具体的に答えてください。\", \"label\": \"rejected-suggestion-and-direct-answer-4\", \"status\": 200, \"firstChunkMs\": 1912, \"doneMs\": 1912, \"totalMs\": 1913, \"hasDone\": true, \"completionStatus\": \"complete\", \"finalizationStatus\": \"complete\", \"finishReason\": \"STOP\", \"modelName\": \"gemini-3.5-flash\", \"provider\": null, \"qualityRepairAttempted\": false, \"qualityRepairAccepted\": false, \"qualityInitialIssues\": [\"unsafe_high_impact_advice\"], \"qualityFinalIssues\": [], \"expectedModelName\": \"\", \"expectedFinishReason\": \"\", \"usage\": {\"prompt_tokens\": 5472, \"completion_tokens\": 91, \"cached_tokens\": 2907, \"total_tokens\": 5563}, \"outputChars\": 89, \"questionMarks\": 0, \"semanticQuestions\": 0, \"rawMessage\": \"支払いの希望を文面にする場合は、希望する家賃の負担額、毎月の支払日、回答期限を一通の文面にまとめてください。希望と実際の支払いを区別すると、相手に確認したい内容が明確になります。\", \"message\": \"支払いの希望を文面にする場合は、希望する家賃の負担額、毎月の支払日、回答期限を一通の文面にまとめてください。希望と実際の支払いを区別すると、相手に確認したい内容が明確になります。\"}]}");
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
if (!specification || !evaluation || !evaluation.includes('別対応を求められた時に既出の書面確認へ戻さない')) throw new Error('Actual evaluator extraction failed');
// Unrelated checks are stubbed. The actual evaluator map, target check and new
// pure helper all execute unchanged from the selected saved source bytes.
const context: Record<string, unknown> = {
  ...quotation,
  seededContinuityScenarios: [], evaluateSeededContinuityResponse: () => [],
  currentTopicUserTexts: (texts: string[]) => texts,
  countCoachingMoves: () => 0,
  getLocalTurnExpectation: () => ({ modelName: '', finishReason: 'STOP' }),
  addCheck: (checks: {name:string;passed:boolean;detail:string}[], name:string, passed:unknown, detail = '') => checks.push({ name, passed: Boolean(passed), detail }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '',
  maxFirstChunkMs: 10000, maxTotalMs: 15000,
};
for (const name of new Set(evaluation.match(/\bcontains[A-Za-z]+(?=\()/g) || [])) {
  if (!(name in context) && name !== 'containsRepeatedWrittenPaymentRequest') context[name] = () => false;
}
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, context, { timeout: 1000 });
const copy = (value: unknown) => JSON.parse(JSON.stringify(value));
const targetLabel = 'rejected-suggestion-and-direct-answer-4';
const targetCheck = `${targetLabel}: 別対応を求められた時に既出の書面確認へ戻さない`;
const writtenEarlier = '希望する家賃の負担額と毎月の支払日、回答期限を一通の文面にまとめてください。';
function scenario({ previous, current, seedHistory, future, onlyCurrent }: {previous?:string;current?:string;seedHistory?:{role:'user'|'assistant';content:string}[];future?:string;onlyCurrent?:boolean} = {}) {
  const actual = copy(snapshot);
  if (previous !== undefined) actual.turns[2].message = previous;
  if (current !== undefined) actual.turns[3].message = current;
  if (seedHistory !== undefined) actual.seedHistory = seedHistory;
  if (onlyCurrent) actual.turns = [actual.turns[3]];
  if (future) actual.turns.push({ ...actual.turns[3], label: 'rejected-suggestion-and-direct-answer-5', user: '次に進みます。', message: future });
  for (const turn of actual.turns) {
    turn.rawMessage = turn.message;
    turn.outputChars = turn.message.length;
  }
  return actual;
}
const cases = [
  { name: 'actual_snapshot_first_written_request_after_questions_and_payment_records', expected: true, conversation: scenario() },
  { name: 'reject_written_request_already_proposed_in_previous_assistant_turn', expected: false, conversation: scenario({ previous: writtenEarlier }) },
  { name: 'allow_third_party_proposal_after_a_written_request', expected: true, conversation: scenario({ previous: writtenEarlier, current: '家賃の支払いについて、地域の相談窓口に今後の対応を一度相談してください。' }) },
  { name: 'reject_semantically_same_amount_due_day_reply_deadline_with_other_wording', expected: false, conversation: scenario({ previous: '希望する負担額と支払日、返答の期日をメールにまとめてください。', current: '負担してほしい額と毎月の支払日、回答期限を一通の文書にまとめてください。' }) },
  { name: 'do_not_treat_actual_payment_history_as_request_even_if_written', expected: true, conversation: scenario({ previous: '直近3か月の家賃額、実際に支払った額、不足額を文面にまとめてください。' }) },
  { name: 'quoted_proposal_explicitly_declined_is_not_previous_advice', expected: true, conversation: scenario({ previous: '「書面で回答を求めてください」という言い方は提案しません。直近3か月の支払実績を記録してください。' }) },
  { name: 'negative_instruction_not_to_ask_for_written_reply_is_not_positive_advice', expected: true, conversation: scenario({ previous: '書面で回答を求めないでください。支払実績を記録してください。' }) },
  { name: 'assistant_reporting_user_quote_is_not_proposing_it', expected: true, conversation: scenario({ previous: 'ユーザーの「希望する負担額と回答期限を文面にまとめてください」という発言を引用しました。' }) },
  { name: 'current_quote_denial_and_third_party_advice_is_not_repeat', expected: true, conversation: scenario({ previous: writtenEarlier, current: '「文面にまとめてください」という提案は繰り返しません。地域の相談窓口に対応を相談してください。' }) },
  { name: 'quoted_field_labels_in_positive_assistant_proposal_still_count', expected: false, conversation: scenario({ previous: '「希望する負担額と回答期限」をメールにまとめてください。' }) },
  { name: 'negative_sentence_does_not_hide_later_positive_written_proposal', expected: false, conversation: scenario({ previous: '文面は今は提案しません。希望する負担額と回答期限をメールにまとめてください。' }) },
  { name: 'future_assistant_turn_does_not_retroactively_make_current_repeat', expected: true, conversation: scenario({ future: writtenEarlier }) },
  { name: 'assistant_seed_positive_proposal_is_prior_advice', expected: false, conversation: scenario({ seedHistory: [{ role: 'assistant', content: writtenEarlier }] }) },
  { name: 'user_seed_request_is_not_prior_assistant_proposal', expected: true, conversation: scenario({ seedHistory: [{ role: 'user', content: writtenEarlier }] }) },
  { name: 'current_candidate_is_not_included_as_its_own_prior_advice', expected: true, conversation: scenario({ onlyCurrent: true }) },
  { name: 'existing_short_followup_bad_written_proposal_remains_rejected', expected: false, conversation: scenario({ previous: 'まず直近3か月の家賃額、相手の支払額、不足額を記録してください。その記録を使い、今後の負担額と支払期日について書面で回答を求める方法があります。', current: '次は回答期限を付けた書面で確認する方法へ切り替えてください。希望する家賃の負担額、毎月の支払日、不足した場合の扱い、回答期限を一通にまとめます。回答がない場合は、その書面と手元で確認できる支払記録を持って、夫婦問題や家計相談の窓口へ相談してください。' }) },
  { name: 'repeat_of_explicit_amount_due_date_confirmation_without_wish_or_reply_words', expected: false, conversation: scenario({ previous: '家賃76,000円と支払期限を夫に書面で確認してください。', current: '家賃76,000円と支払期限を夫に書面で確認してください。' }) },
  { name: 'old_written_confirmation_method_progress_form_remains_rejected', expected: false, conversation: scenario({ previous: writtenEarlier, current: '書面で確認する方法へ進んでください。' }) },
  { name: 'prior_proposal_question_about_amount_and_deadline_counts_as_advice', expected: false, conversation: scenario({ previous: '金額と期限を書面で確認できますか？', current: '家賃76,000円と支払期限を夫に書面で確認してください。' }) },
];

const results: unknown[] = [];
afterAll(() => {
 const output = process.env.ACTI_WRITTEN_REQUEST_REPLAY_OUTPUT;
 if (output) writeFileSync(output, JSON.stringify({scope:'Actual target check with unrelated checks stubbed',results},null,2), {flag:'wx',mode:0o600});
});
describe('rejected suggestion evaluator compares only prior assistant proposals', () => {
 it.each(cases)('$name', item => {
  const matches = evaluate([item.conversation]).checks.filter((check: {name:string;passed:boolean}) => check.name === targetCheck);
  results.push({name:item.name,expected:item.expected,actual:matches[0]?.passed,exactInputConversation:item.conversation,targetMatches:matches});
  expect(matches).toHaveLength(1);
  expect(matches[0].passed).toBe(item.expected);
 });
});
