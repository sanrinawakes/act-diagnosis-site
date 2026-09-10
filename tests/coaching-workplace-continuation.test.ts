import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution, normalizeCoachingOutput } from '../src/lib/coaching-gemini';
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
  it.each(['minimal', 'legacy'])('does not add unspoken loneliness when listening in %s mode', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const lastUserText = '今は課題を出さずに、話を聞いてほしいです。';
    const text = normalizeCoachingOutput('今は話を聞いてほしいのですね。どれほど心細い思いをされていることかと思います。話の順番が前後しても構いません。', lastUserText, history);
    expect(text).not.toContain('心細');
    expect(text).toContain('聞');
  });
  it('retains loneliness that the user actually described', () => {
    const text = normalizeCoachingOutput('心細い思いをしているのですね。話の順番が前後しても構いません。', '心細いので、話を聞いてほしいです。', history);
    expect(text).toContain('心細');
  });
  it.each(['minimal', 'legacy'])('checks unspoken feelings at the delivery boundary in %s mode', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const lastUserText = '今は課題を出さずに、話を聞いてほしいです。';
    const text = '今は話を聞いてほしいのですね。どれほど心細い思いをされていることかと思います。こちらから新しい課題や質問を増やすことはしません。話の順番が前後しても構いません。あなたの話の続きを聞きます。';
    const issues = assessCoachingResponseQuality({ text, lastUserText, historyMessages: history }).issues;
    expect(issues).toContain('context_mismatch');
    const result = ensureVerifiedCoachingResolution({ resolution: { text, usage: {}, modelName: 'test', repairAttempted: false, repairAccepted: false, initialIssues: issues, finalIssues: issues }, lastUserText, historyMessages: history });
    expect(result.text).not.toContain('心細');
    expect(result.finalIssues).toEqual([]);
  });
  it('does not treat a question about feelings as an assertion', () => {
    expect(assessCoachingResponseQuality({ text: '心細い気持ちはありますか？', lastUserText: '今の気持ちについて質問してください。', historyMessages: [] }).issues).not.toContain('context_mismatch');
  });
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
  it('does not append a question when asked to listen without tasks', () => {
    const lastUserText='今は課題を出さずに、話を聞いてほしいです。';
    const body='今は話を聞いてほしいのですね。仕事で起きたことを、すぐ行動計画に変える必要はありません。答えたくないことは答えなくてよく、話の順番が前後しても構いません。こちらから質問を重ねず、あなたの話の続きを聞きます。';
    const text=normalizeCoachingOutput(body,lastUserText,history);
    expect(text).not.toMatch(/[？?]|変えてほしいですか/);
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:history}).issues).toEqual([]);
    expect(buildFinalVerifiedQualityFallback(lastUserText,history)).not.toMatch(/[？?]|という相談ですね/);
  });
  it('rejects an added question after an explicit listening request', () => {
    const lastUserText='今は話を聞いてほしいです。';
    expect(assessCoachingResponseQuality({text:'それでは、その相手にどのような行動を変えてほしいですか？',lastUserText,historyMessages:history}).issues).toContain('repeats_rejected_move');
  });
  it('preserves an explicitly requested question while listening', () => {
    const lastUserText='話を聞いてほしいです。最後に質問を一つしてください。';
    const text=normalizeCoachingOutput('今の話を聞きます。どの場面から話したいですか？',lastUserText,history);
    expect(text).toMatch(/[？?]/);
  });
  it.each(['別の話です。旅行の計画を立てたいです。','今日はここで終わります。'])('does not hijack a changed or closed topic: %s', (lastUserText) => {
    expect(buildFinalVerifiedQualityFallback(lastUserText,history)).not.toMatch(/同僚|職場|故障/);
  });
  it('does not import workplace context from a saved summary', () => {
    const h: CoachingChatMessage[] = [{role:'user',content:'以下は過去の会話の保存済み要約です。職場の同僚に無視された。'}];
    expect(buildFinalVerifiedQualityFallback('はい',h)).not.toContain('同僚');
  });
  it('verifies recovery through every turn even when all model candidates are rejected', () => {
    const h: CoachingChatMessage[]=[];
    for(const lastUserText of [history[0].content, cases[0][0], cases[1][0], '責任者に勤務をずらせるか相談したいです。', 'できれば今週中に相談したいです。', '以前の職場でも人間関係がつらくて退職することが多かったです。', '今は課題を出さずに、話を聞いてほしいです。']) {
      const text=buildFinalVerifiedQualityFallback(lastUserText,h);
      expect(text).not.toMatch(/という相談ですね|まだ書かれていない原因|次に決める項目/);
      expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
      h.push({role:'user',content:lastUserText},{role:'assistant',content:text});
    }
  });
  it.each(['minimal','legacy'])('recovers a truncated past-tense acknowledgement in %s mode',mode=>{
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const lastUserText='以前の職場でも人間関係がつらくて退職することが多かったです。';
    const text='退職することが多かっのですね。今の職場で続けるかどうかをすぐ決める必要はありません。以前の経験と今の状況を分けて考えられます。今の職場で困っていることを責任者へ話す機会はありますか？';
    const issues=assessCoachingResponseQuality({text,lastUserText,historyMessages:history}).issues;
    expect(issues).toContain('fragmented_expression');
    const result=ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:issues,finalIssues:issues},lastUserText,historyMessages:history});
    expect(result.finalIssues).toEqual([]);
    expect(result.text).not.toContain('かっの');
  });
  it('does not flag a correctly inflected past-tense acknowledgement',()=>{
    expect(assessCoachingResponseQuality({text:'以前も人間関係で退職することが多かったのですね。',lastUserText:'以前も退職することが多かったです。',historyMessages:history}).issues).not.toContain('fragmented_expression');
  });
  it.each(['minimal','legacy'])('rejects a duplicated wake-up verb in %s mode',mode=>{
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const lastUserText='明日の朝に始める行動を一つだけ、質問なしで答えてください。';
    const text='明日の朝、起き起きたら最初に今日最優先で進める作業を一つだけメモに書き出してください。';
    const issues=assessCoachingResponseQuality({text,lastUserText,historyMessages:[]}).issues;
    expect(issues).toContain('fragmented_expression');
    const result=ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:issues,finalIssues:issues},lastUserText,historyMessages:[]});
    expect(result.text).not.toContain('起き起き');
    expect(result.finalIssues).toEqual([]);
  });
  it('accepts a normal wake-up verb',()=>{
    expect(assessCoachingResponseQuality({text:'明日の朝、起きたら最優先の作業を一つだけメモに書いてください。',lastUserText:'明日の朝に始める行動を一つだけ答えてください。',historyMessages:[]}).issues).not.toContain('fragmented_expression');
  });
  it.each(['明日の予定をメモに書き書きます。','明日の朝、メモの最初の行を読み読みます。'])('rejects repeated stems before inflection: %s',text=>{
    expect(assessCoachingResponseQuality({text,lastUserText:'明日の行動を一つだけ教えてください。',historyMessages:[]}).issues).toContain('fragmented_expression');
  });
  it('preserves natural Japanese reduplication',()=>{
    expect(assessCoachingResponseQuality({text:'一つ一つの出来事を話す時、生き生きとしていましたね。',lastUserText:'一つ一つ話している時は生き生きしていました。',historyMessages:[]}).issues).not.toContain('fragmented_expression');
  });
  it.each(['minimal','legacy'])('avoids unverified claims about a prior question in listening-only %s replies',mode=>{
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const lastUserText='今は相手に何かを伝える課題は出さず、話を聞いてほしいです。';
    const h:CoachingChatMessage[]=[...history,{role:'assistant',content:'以前の職場では、どのようなことが一番つらかったですか？'}];
    const text='今は話を聞いてほしいのですね。前回の質問で相手へ伝える内容を聞いてしまい、負担をかけてしまいました。今は新しい課題を決めず、これまでの職場での出来事や気持ちの話を聞きます。';
    const issues=assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues;
    expect(issues).toContain('context_mismatch');
    const result=ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:issues,finalIssues:issues},lastUserText,historyMessages:h});
    expect(result.text).not.toMatch(/前回の質問|[？?]/);
    expect(result.text).toContain('話');
    expect(result.finalIssues).toEqual([]);
  });
  it('also rejects a retrospective claim about the previous response',()=>{
    expect(assessCoachingResponseQuality({text:'先ほどの返答で伝え方を求めてしまいました。今は話を聞きます。',lastUserText:'課題は出さず、話を聞いてほしいです。',historyMessages:history}).issues).toContain('context_mismatch');
  });
  it('preserves listening without an invented description of the prior turn',()=>{
    expect(assessCoachingResponseQuality({text:'今は新しい課題を決めず、これまで職場で起きたことや、その時に感じたことの続きを聞きます。',lastUserText:'課題は出さず、話を聞いてほしいです。',historyMessages:history}).issues).not.toContain('context_mismatch');
  });
  it('does not block an explicitly requested account of the previous question',()=>{
    expect(assessCoachingResponseQuality({text:'前回の質問は、以前の職場で一番つらかったことについてでした。',lastUserText:'前回何を質問したのか教えてください。',historyMessages:history}).issues).not.toContain('context_mismatch');
  });
  it.each(['仕事上の対処はできました。そうではなく、その人に頼るのが嫌だった気持ちの話です。','今は何もしたくありません。'])('does not invent a previous assistant mistake in local recovery: %s',lastUserText=>{
    const h:CoachingChatMessage[]=[...history,{role:'assistant',content:'その時、何が一番つらかったですか？'}];
    const text=buildFinalVerifiedQualityFallback(lastUserText,h);
    expect(text).not.toMatch(/前の返答では|こちらから次の行動を求めすぎ/);
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages:h}).issues).toEqual([]);
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
