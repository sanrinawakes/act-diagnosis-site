import { describe, expect, it } from 'vitest';
import { resolveShorteningActionTimeRequest, containsShorteningActionTimeMismatch } from '../src/lib/coaching-action-language.mjs';

const original = 'E2E-1792206266322-ebbe72e3-a1。明日の一歩を一つ教えてください。';
const latest = 'E2E-1792206266322-ebbe72e3-a2。短く答えてください。';
const bad = '今、次に終わらせる用事を一つだけ紙に書いてください。';
const good = '明日、終わらせたい用事を一つだけ紙に書いてください。';

describe('a formatting request retains the active user action day', () => {
  it.each([latest, '短く答えてください。', 'もう少し短くしてください。', '簡潔に答えてください。', '一文で答えてください。'])('keeps the user day for %s', followup => {
    expect(resolveShorteningActionTimeRequest(followup, [original, followup])).toBe(original);
    expect(containsShorteningActionTimeMismatch(bad, followup, [original, followup])).toBe(true);
    expect(containsShorteningActionTimeMismatch(good, followup, [original, followup])).toBe(false);
  });
  it('retains the day through consecutive format requests without an assistant source', () => {
    expect(resolveShorteningActionTimeRequest(latest, [original, '一文で答えてください。', latest])).toBe(original);
  });
  it.each(['明日、今、用事を一つ紙に書いてください。', '今夜、用事を一つ紙に書いてください。', '今日中に用事を一つ紙に書いてください。', '明日ではなく今日、用事を一つ紙に書いてください。', '用事を一つ紙に書いてください。'])('rejects a missing or conflicting execution day: %s', candidate => {
    expect(containsShorteningActionTimeMismatch(candidate, latest, [original, latest])).toBe(true);
  });
  it('keeps an explicit requested morning', () => {
    const request = '明日の朝に始める行動を一つだけ教えてください。';
    expect(containsShorteningActionTimeMismatch(good, latest, [request, latest])).toBe(true);
    expect(containsShorteningActionTimeMismatch('明日の朝、用事を一つ紙に書いてください。', latest, [request, latest])).toBe(false);
  });
  it.each([
    '今の行動に変更して、短く答えてください。',
    '明日ではなく今日です。短く答えてください。',
    'ところで、短く答えてください。',
    '話題を変えます。短く答えてください。',
    '今日は疲れています。短く答えてください。',
    'Tomorrow。短く答えてください。',
    '「短く答えてください」と言われました。',
    '短く答えてくださいとは言っていません。',
    '明日の行動は取り消します。短く答えてください。',
  ])('does not discard substantive changes in %s', followup => {
    expect(resolveShorteningActionTimeRequest(followup, [original, followup])).toBe(followup);
    expect(containsShorteningActionTimeMismatch(bad, followup, [original, followup])).toBe(false);
  });
  it.each([
    '私は明日の行動を依頼していません。',
    '明日の行動依頼は撤回します。',
    '明日の一歩はやめて、今日の行動を一つ教えてください。',
    '同僚が明日の行動を教えてほしいと言っています。',
    '夫は明日の一歩を一つ教えてくださいと言いました。',
    '明日の一歩を一つ教えてくださいと夫が言いました。',
    '「明日の一歩を一つ教えてください」とAIに言われました。',
    'もし明日始めるなら何をすればいいですか？',
    '明日の予定はまだ決めていません。',
    'ところで、今の話は家族との関係です。',
    '今日は休みたいです。',
  ])('does not reuse an older date past the latest substantive user turn: %s', intervening => {
    const users = [original, intervening, latest];
    expect(resolveShorteningActionTimeRequest(latest, users)).toBe(latest);
    expect(containsShorteningActionTimeMismatch(bad, latest, users)).toBe(false);
  });
  it('does not treat a saved summary as the user action request', () => {
    expect(resolveShorteningActionTimeRequest(latest, ['以下は過去の会話の保存済み要約です。明日の一歩を一つ教えてください。', latest])).toBe(latest);
  });
  it('keeps an explicit retrospective task distinct from its tomorrow execution day', () => {
    const request = '明日の朝、今日の仕事を振り返る行動を一つ教えてください。';
    const candidate = '明日の朝、今日の仕事を一つ思い出してください。';
    expect(resolveShorteningActionTimeRequest(latest, [request, latest])).toBe(request);
    expect(containsShorteningActionTimeMismatch(candidate, latest, [request, latest])).toBe(false);
  });
  it('does not invent a date when the user has never requested one', () => {
    expect(resolveShorteningActionTimeRequest(latest, [latest])).toBe(latest);
    expect(containsShorteningActionTimeMismatch(bad, latest, [latest])).toBe(false);
  });
});
