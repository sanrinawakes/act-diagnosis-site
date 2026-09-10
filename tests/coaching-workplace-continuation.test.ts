import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution } from '../src/lib/coaching-gemini';
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';

const history: CoachingChatMessage[] = [
  { role: 'user', content: '職場の同僚に無視されるので、助けを頼むのがつらいです。責任者はいつもいるわけではありません。' },
  { role: 'assistant', content: '最近、仕事中に困った出来事を教えてください。' },
];
const cases = [
  ['受付の端末が故障して、お客さんを待たせてしまった。', /故障|機器/],
  ['作業の対処ではなく、嫌な人に頼る気持ちの話です。', /気持ち|つら/],
  ['何もしたくありません。', /無理に|急いで/],
] as const;
describe('workplace conflict recovery', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(cases)('grounds recovery in the current concern: %s', (lastUserText, expected) => {
    const text = buildFinalVerifiedQualityFallback(lastUserText, history);
    expect(text).toMatch(expected);
    expect(text).not.toMatch(/という相談ですね|まだ書かれていない|明日の朝|次に決める項目/);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: history }).issues).toEqual([]);
  });
  it.each(['minimal', 'legacy'])('delivers a verified recovery in %s mode', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const result = ensureVerifiedCoachingResolution({ resolution: { text: 'という相談ですね。', usage: {}, modelName: 'test', repairAttempted: false, repairAccepted: false, initialIssues: ['too_short'], finalIssues: ['too_short'] }, lastUserText: cases[0][0], historyMessages: history });
    expect(result.finalIssues).toEqual([]);
    expect(result.text).toMatch(/故障|機器/);
  });
  it('uses the preceding question to interpret a yes about leaving jobs', () => {
    const h: CoachingChatMessage[] = [...history, {role:'user',content:'以前の職場でも人間関係がつらくなりました。'}, {role:'assistant',content:'その時は退職することが多かったですか？'}];
    const text = buildFinalVerifiedQualityFallback('ええ、そうです。',h);
    expect(text).toContain('退職');
    expect(text).not.toMatch(/明日の朝|一文だけ.*メモ/);
    expect(assessCoachingResponseQuality({text,lastUserText:'ええ、そうです。',historyMessages:h}).issues).toEqual([]);
  });
  it('accepts a correction about when to consult a manager', () => {
    const h: CoachingChatMessage[] = [...history, {role:'user',content:'責任者に勤務をずらせるか相談します。'}, {role:'assistant',content:'相談するのは来月にする予定ですか？'}];
    const text = buildFinalVerifiedQualityFallback('いいえ、できれば今週です。',h);
    expect(text).toContain('今週');
    expect(text).not.toMatch(/という相談ですね|原因を推測/);
    expect(assessCoachingResponseQuality({text,lastUserText:'いいえ、できれば今週です。',historyMessages:h}).issues).toEqual([]);
  });
  it('does not reinterpret a future resignation preference as repeated past resignations', () => {
    const h: CoachingChatMessage[] = [...history,{role:'assistant',content:'今の職場を退職したいですか？'}];
    expect(buildFinalVerifiedQualityFallback('はい',h)).not.toContain('退職を選ぶことが多かった');
  });
  it('responds to a direct account of repeated resignations', () => {
    const text=buildFinalVerifiedQualityFallback('前の職場でも人間関係に悩んで退職することが多かったです。',history);
    expect(text).toContain('退職を選ぶことが多かった');
    expect(text).not.toContain('という相談ですね');
  });
  it('accepts a timing preference after a suggestion, without inventing an earlier misunderstanding', () => {
    const h: CoachingChatMessage[]=[...history,{role:'assistant',content:'責任者に勤務の相談をしてみてください。'}];
    const text=buildFinalVerifiedQualityFallback('今週のうちに相談したいです。',h);
    expect(text).toContain('今週');
    expect(text).not.toMatch(/受け取ってしま|という相談ですね/);
  });
  it('opens a workplace-conflict discussion without a generic planning directive', () => {
    const text=buildFinalVerifiedQualityFallback(history[0].content,[]);
    expect(text).toContain('無視される相手');
    expect(text).not.toContain('という相談ですね');
  });
  it.each(['別の話です。旅行の計画を立てたいです。','今日はここで終わります。'])('does not hijack a changed or closed topic: %s', (lastUserText) => {
    expect(buildFinalVerifiedQualityFallback(lastUserText,history)).not.toMatch(/同僚|職場|故障/);
  });
  it('does not import workplace context from a saved summary', () => {
    const h: CoachingChatMessage[] = [{role:'user',content:'以下は過去の会話の保存済み要約です。職場の同僚に無視された。'}];
    expect(buildFinalVerifiedQualityFallback('はい',h)).not.toContain('同僚');
  });
  it('retains the concern while the user describes several practical details', () => {
    const h: CoachingChatMessage[] = [...history];
    for (const content of ['昼の勤務です。','責任者は不在です。','お客さんがいます。','その場で判断します。','後には回せません。','うまく説明できません。','具体的な出来事を話します。']) {
      h.push({role:'user',content},{role:'assistant',content:'続けてください。'});
    }
    expect(buildFinalVerifiedQualityFallback(cases[0][0],h)).not.toContain('という相談ですね');
  });
  it('does not recover an old workplace topic after an intervening topic change', () => {
    const h: CoachingChatMessage[] = [...history,{role:'user',content:'別の話です。自宅の端末についてです。'},{role:'assistant',content:'端末はどのような状態ですか？'}];
    expect(buildFinalVerifiedQualityFallback('端末が故障しました。',h)).not.toContain('助けを頼む相手');
  });
});
