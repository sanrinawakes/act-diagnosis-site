import { describe, expect, it } from 'vitest';
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution, type CoachingChatMessage } from '../src/lib/coaching-gemini';
const generic = 'まだ書かれていない原因を推測せず、実際に起きたことと、次に困る場面を分けると、具体的な対応を選びやすくなります。';
const history: CoachingChatMessage[] = [
  { role: 'user', content: '人間関係について相談したいです' },
  { role: 'assistant', content: '最後に困った場面で、相手が実際にしたことを一つ教えてください。' },
];
describe('contextual recovery instead of generic cause analysis', () => {
  it.each(['写真の講座をつくりたい', '料理教室を作りたい', '文章の講座を開きたい'])('answers a course creation goal: %s', lastUserText => {
    const text = buildFinalVerifiedQualityFallback(lastUserText, []);
    expect(text).not.toContain('原因を推測');
    expect(text).toMatch(/受講|参加|学ぶ/);
    expect(text).toMatch(/誰|どんな人|対象/);
    expect(assessCoachingResponseQuality({text,lastUserText}).issues).toEqual([]);
  });
  it.each(['むしする', '無視する', '無視される'])('continues the immediately preceding relationship question: %s', lastUserText => {
    const result=ensureVerifiedCoachingResolution({ resolution: {text:generic,usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:['too_short'],finalIssues:['too_short']},lastUserText,historyMessages:history });
    expect(result.text).not.toContain('原因を推測');
    expect(result.text).toMatch(/返事|無視/);
    expect(result.text).not.toContain('相手が実際にしたことを一つ');
    expect(result.finalIssues).toEqual([]);
  });
  it('does not invent a subject for an isolated ambiguous action', () => {
    const text=buildFinalVerifiedQualityFallback('むしする',[]);
    expect(text).toMatch(/ご自身|あなた/);
    expect(text).toMatch(/相手/);
    expect(text).not.toContain('原因を推測');
    expect(assessCoachingResponseQuality({text,lastUserText:'むしする'}).issues).toEqual([]);
  });
  it('flags the stock explanation even when padded enough to pass length checks', () => {
    expect(assessCoachingResponseQuality({text:`「写真の講座をつくりたい」という相談ですね。${generic}今の情報だけで原因や相手の意図を決めつけず、確認できる出来事から整理します。`,lastUserText:'写真の講座をつくりたい'}).issues).toContain('generic_canned_close');
  });
  it('does not borrow a relationship subject across a topic switch', () => {
    const switched:CoachingChatMessage[]=[...history,{role:'user',content:'話を変えて、通知の設定についてです'},{role:'assistant',content:'通知をどうしたいですか？'}];
    const text=buildFinalVerifiedQualityFallback('むしする',switched);
    expect(text).not.toContain('相手から返事や反応がない、ということですね');
    expect(text).toContain('どちらの意味');
  });
});
