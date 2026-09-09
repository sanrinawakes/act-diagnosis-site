import { describe, expect, it, afterEach, vi } from 'vitest';
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution } from '../src/lib/coaching-gemini';
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';

const history: CoachingChatMessage[] = [
  { role: 'user', content: '保育の現場で子ども同士が叩き合うのを防ぎたいです。職員が気づいたら止め、担当者へ報告する方針です。' },
  { role: 'assistant', content: '職員には、どのように見守ってほしいですか？' },
];
describe('child safety conversation fallback', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['minimal', 'legacy'])('verifies recovery at the delivery boundary in %s mode', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const lastUserText = '手を出す子を注意して見ておくということです。';
    const result = ensureVerifiedCoachingResolution({
      resolution: { text: 'という相談ですね。', usage: {}, modelName: 'test', repairAttempted: false, repairAccepted: false, initialIssues: ['too_short'], finalIssues: ['too_short'] },
      lastUserText, historyMessages: history,
    });
    expect(result.finalIssues).toEqual([]);
    expect(result.text).toContain('見守');
    expect(result.chargeable).toBe(false);
  });
  it.each(['叩いてしまう子の様子を近くで見守るという意味です。', '手を出す子を注意して見ておくということです。'])('continues an observation answer: %s', (lastUserText) => {
    const text = buildFinalVerifiedQualityFallback(lastUserText, history);
    expect(text).toMatch(/見守|見て/);
    expect(text).toMatch(/職員|担当/);
    expect(text).not.toContain('という相談ですね');
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:history}).issues).toEqual([]);
  });
  it('recognizes a child referred to without repeating the domain noun', () => {
    const h: CoachingChatMessage[] = [{role:'user',content:'暴行を見つけたら対応して、担任へ報告する決まりにします。'}];
    const lastUserText = 'その子の行動をよく見ておくという意味です。';
    const text = buildFinalVerifiedQualityFallback(lastUserText,h);
    expect(text).toContain('職員');
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
  });
  it('helps turn remembered events into a record without inventing facts', () => {
    const h: CoachingChatMessage[] = [...history, {role:'user', content:'職員が子どもを叩いた件を報告します。'}, {role:'assistant', content:'日時や出来事の記録はありますか？'}];
    const lastUserText = '記録はこれからですが、出来事は覚えています。';
    const text = buildFinalVerifiedQualityFallback(lastUserText,h);
    expect(text).toMatch(/日時/);
    expect(text).toMatch(/不明|曖昧/);
    expect(text).not.toContain('という相談ですね');
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
  });
  it('keeps clarification followups useful after its own recovery answer', () => {
    const h: CoachingChatMessage[] = [...history];
    for (const lastUserText of ['見守る子の行動を追っておく方針です。', '叩いてしまう子の様子を近くで見守るという意味です。', '手を出す子を注意して見ておくということです。']) {
      const text = buildFinalVerifiedQualityFallback(lastUserText, h);
      expect(text).not.toContain('という相談ですね');
      expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
      h.push({role:'user',content:lastUserText},{role:'assistant',content:text});
    }
  });
  it('continues a record answer after already describing the record format', () => {
    const first = '職員が子どもを叩いた件を報告するため記録したいです。';
    const answer = buildFinalVerifiedQualityFallback(first, []);
    const h: CoachingChatMessage[] = [{role:'user',content:first},{role:'assistant',content:answer}];
    const lastUserText = '記録はこれからですが、出来事は覚えています。';
    const text = buildFinalVerifiedQualityFallback(lastUserText,h);
    expect(text).not.toContain('という相談ですね');
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
  });
  it('keeps a clarification grounded after an intervening model answer', () => {
    const first = '見守る子の行動を追っておく方針です。';
    const answer = buildFinalVerifiedQualityFallback(first, history);
    const h: CoachingChatMessage[] = [...history,{role:'user',content:first},{role:'assistant',content:answer},{role:'user',content:'叩いてしまう子の様子を近くで見守るという意味です。'},{role:'assistant',content:'子どもの近くで様子を見るという意味ですね。危険を感じた時にどう対応するか決まっていますか？'}];
    const lastUserText = '手を出す子を注意して見ておくということです。';
    const text = buildFinalVerifiedQualityFallback(lastUserText,h);
    expect(text).not.toContain('という相談ですね');
    expect(text).toContain('見守る対象と方法');
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
  });
  it('acknowledges uncertain event times instead of restarting the discussion', () => {
    const first = '職員が子どもを叩いた件を報告するため記録したいです。';
    const h: CoachingChatMessage[] = [{role:'user',content:first},{role:'assistant',content:buildFinalVerifiedQualityFallback(first,[])}];
    const lastUserText = '時刻ははっきり覚えていません。推測で書かず、不明とするつもりです。';
    const text = buildFinalVerifiedQualityFallback(lastUserText,h);
    expect(text).toContain('日時が確かではない');
    expect(text).not.toContain('という相談ですね');
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
  });
  it('does not turn a correction into an older relationship topic', () => {
    const h: CoachingChatMessage[] = [{role:'user',content:'前は夫への返事を考えていました。'}, ...history, {role:'user',content:'担当者が子どもの説明を聞いていないという意味です。'}];
    const text = buildFinalVerifiedQualityFallback('相談ではありません。', h);
    expect(text).not.toMatch(/彼|大好き|告白/);
  });
  it('does not apply school safety advice after a topic change', () => {
    const text = buildFinalVerifiedQualityFallback('話を変えます。旅行の持ち物を決めたいです。',history);
    expect(text).not.toMatch(/叩|見守|保育/);
  });
});
