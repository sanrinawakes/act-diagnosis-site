import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution } from '../src/lib/coaching-gemini';
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';
describe('concrete planning recovery', () => {
  afterEach(()=>vi.unstubAllEnvs());
  it.each(['minimal','legacy'])('rejects a missing copula in a refusal example in %s mode',mode=>{
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const lastUserText='仕事の依頼を断る言い方を一つ教えてください。';
    const text='「お声がけありがとうございます。あいにく現在の業務で手がいっぱいため、今回はお引き受けできません。」';
    const issues=assessCoachingResponseQuality({text,lastUserText,historyMessages:[]}).issues;
    expect(issues).toContain('fragmented_expression');
    const result=ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:issues,finalIssues:issues},lastUserText,historyMessages:[]});
    expect(result.text).not.toContain('いっぱいため');
    expect(result.finalIssues).toEqual([]);
  });
  it.each(['準備が必要ため、今日は確認してください。','操作が複雑ので、手順をメモしてください。'])('rejects missing copulas: %s',text=>{
    expect(assessCoachingResponseQuality({text,lastUserText:'次に何をすればよいですか。',historyMessages:[]}).issues).toContain('fragmented_expression');
  });
  it.each(['手がいっぱいのため、今回はお引き受けできません。','準備が必要なので、今日は確認してください。'])('preserves grammatical reasons: %s',text=>{
    expect(assessCoachingResponseQuality({text,lastUserText:'言い方を教えてください。',historyMessages:[]}).issues).not.toContain('fragmented_expression');
  });
  it.each(['minimal','legacy'])('rejects an unrelated English word replacing a Japanese duration in %s mode',mode=>{
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const lastUserText='来月から勤務開始が一時間早くなります。通勤には四十分かかり、朝食準備も私が担当しています。';
    const text='来月から勤務開始が一時間早くなり、通勤の四十 milkと朝食の準備をあなたが担当されているのですね。\n\nこの勤務開始が一時間早くなることについて、あなたはどのように感じていますか。';
    const issues=assessCoachingResponseQuality({text,lastUserText,historyMessages:[]}).issues;
    expect(issues).toContain('fragmented_expression');
    const result=ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:issues,finalIssues:issues},lastUserText,historyMessages:[]});
    expect(result.text).not.toContain('milk');
    expect(result.text).toMatch(/勤務|通勤/);
    expect(result.finalIssues).toEqual([]);
  });
  it.each(['移動に三十bananaかかるのですね。','準備に二十 appleかかるのですね。'])('detects malformed Japanese quantities: %s',text=>{
    expect(assessCoachingResponseQuality({text,lastUserText:'朝の予定について話します。',historyMessages:[]}).issues).toContain('fragmented_expression');
  });
  it.each(['五 km走る予定なのですね。','二十 kgの荷物なのですね。'])('preserves ordinary unit notation: %s',text=>{
    expect(assessCoachingResponseQuality({text,lastUserText:'明日の予定について話します。',historyMessages:[]}).issues).not.toContain('fragmented_expression');
  });
  it('preserves an English word explicitly supplied by the user',()=>{
    expect(assessCoachingResponseQuality({text:'「四十 milk」と書いてあるのですね。',lastUserText:'資料には四十 milkと書いてあります。',historyMessages:[]}).issues).not.toContain('fragmented_expression');
  });
  const cases: [string,string[],RegExp][] = [
    ['新サービスの説明資料を作っています。',[],/資料/],
    ['対象は初めて利用する人です。',['新サービスの説明資料を作っています。'],/初めて/],
    ['担当者から、資料は金曜午後3時までと言われました。',['サービスの説明資料を作っています。'],/金曜午後3時/],
    ['断ると関係が悪くなる気がします。',['友人の誘いを断りたいのに返事を先延ばしにしています。'],/友人/],
    ['そうかも。',['友人の誘いを断りたいです。','断ると関係が悪くなる気がします。'],/友人/],
    ['仕事の締切が重なり、優先順位を決めたいです。',[],/締切/],
    ['来月から勤務開始が一時間早くなります。通勤には四十分かかり、朝食準備も私が担当しています。',[],/勤務|通勤/],
    ['来週から出勤時間が遅くなります。通勤と家事の時間について話したいです。',[],/勤務|通勤/],
  ];
  it.each(cases)('keeps the subject and avoids canned recovery: %s',(lastUserText,users,expected)=>{
    const historyMessages: CoachingChatMessage[]=users.map(content=>({role:'user',content}));
    const text=buildFinalVerifiedQualityFallback(lastUserText,historyMessages);
    expect(text).toMatch(expected);
    expect(text).not.toMatch(/という相談ですね|まだ書かれていない|本人が実際の伝え方|次に決める項目/);
    expect(assessCoachingResponseQuality({text,lastUserText,historyMessages}).issues).toEqual([]);
  });
  it('does not import a presentation topic after a topic switch',()=>{
    const historyMessages: CoachingChatMessage[]=[{role:'user',content:'サービスの説明資料を作ります。'},{role:'user',content:'別件です。友人の誕生日会について話します。'}];
    expect(buildFinalVerifiedQualityFallback('金曜午後3時までです。',historyMessages)).not.toContain('資料の締切');
  });
  it.each(['minimal','legacy'])('recovers a changed morning schedule in %s mode',mode=>{
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const lastUserText='来月から勤務開始が一時間早くなります。通勤には四十分かかり、朝食準備も私が担当しています。';
    const result=ensureVerifiedCoachingResolution({resolution:{text:'という相談ですね。',usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:['too_short'],finalIssues:['too_short']},lastUserText,historyMessages:[]});
    expect(result.text).toContain('勤務時間');
    expect(result.text).not.toMatch(/という相談ですね|まだ書かれていない|不安|心細/);
    expect(result.finalIssues).toEqual([]);
  });
  it.each(['minimal','legacy'])('recovers presentation introductions at the %s delivery boundary',mode=>{
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const h:CoachingChatMessage[]=[];
    for(const lastUserText of ['新しい企画の説明資料を作っています。','対象は初めてサービスを使う人です。']){
      const result=ensureVerifiedCoachingResolution({resolution:{text:'という相談ですね。',usage:{},modelName:'test',repairAttempted:false,repairAccepted:false,initialIssues:['too_short'],finalIssues:['too_short']},lastUserText,historyMessages:h});
      expect(result.text).not.toMatch(/という相談ですね|仕事全体について結論/);
      expect(result.finalIssues).toEqual([]);
      h.push({role:'user',content:lastUserText},{role:'assistant',content:result.text});
    }
  });
});
