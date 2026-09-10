import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution } from '../src/lib/coaching-gemini';
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';
describe('concrete planning recovery', () => {
  afterEach(()=>vi.unstubAllEnvs());
  const cases: [string,string[],RegExp][] = [
    ['新サービスの説明資料を作っています。',[],/資料/],
    ['対象は初めて利用する人です。',['新サービスの説明資料を作っています。'],/初めて/],
    ['担当者から、資料は金曜午後3時までと言われました。',['サービスの説明資料を作っています。'],/金曜午後3時/],
    ['断ると関係が悪くなる気がします。',['友人の誘いを断りたいのに返事を先延ばしにしています。'],/友人/],
    ['そうかも。',['友人の誘いを断りたいです。','断ると関係が悪くなる気がします。'],/友人/],
    ['仕事の締切が重なり、優先順位を決めたいです。',[],/締切/],
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
