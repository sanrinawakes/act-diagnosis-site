import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ raw: '', provider: 0, alerts: 0, fetch: 0 }));
const futurePlanMockCalls = vi.hoisted(() => ({ primary: 0, repair: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
 sendMessageStream: async () => { futurePlanMockCalls.primary++; return ({stream:(async function*(){yield{text:()=>transport.raw};})(),response:Promise.resolve({candidates:[{finishReason:'STOP'}],usageMetadata:{totalTokenCount:2}})}); },
 sendMessage: async () => { futurePlanMockCalls.repair++; return ({response:{text:()=>transport.raw,candidates:[{finishReason:'STOP'}]}}); },
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates',()=>({generateCoachingProviderCandidate:async()=>{transport.provider++;throw Error('PROVIDER_FORBIDDEN');}}));
vi.mock('@/lib/coaching-alerts',()=>({sendCoachingAlert:async()=>{transport.alerts++;throw Error('ALERT_FORBIDDEN');}}));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution, normalizeCoachingOutput, buildGeminiParts, createJsonLineStream } from "../src/lib/coaching-gemini";
import { containsUngroundedTaskAssumption } from "../src/lib/coaching-action-language.mjs";
import { getContextualizedPrompt } from "../src/data/coaching-system-prompt";
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';

// Exact synthetic history and public final from production trace13086-55.
// The injected text is delivered public output, not original provider raw.
const history: CoachingChatMessage[] = [
  {
    "role": "user",
    "content": "夫に家事を頼んでも後回しにされます。私ばかり負担している気がして腹が立ちます。"
  },
  {
    "role": "assistant",
    "content": "家事を頼んでも後回しにされ、自分ばかり負担しているように感じて腹が立つんですね。頼んだ家事を結局自分が引き受ける状態なら、一回の家事ではなく、分担が機能していないことが問題です。\n\n夫に、最初に担当を固定してほしい家事はどれですか？"
  },
  {
    "role": "user",
    "content": "家事そのものより、私の時間を軽く扱われているように感じることが嫌なんです。"
  },
  {
    "role": "assistant",
    "content": "家事そのものより、自分の時間を軽く扱われているように感じることが嫌なんですね。家事の量に加えて、頼んだ時にどのように応じてほしいかも、話し合う内容になります。\n\n夫に、家事を頼んだ時どんな返答をしてほしいですか？"
  },
  {
    "role": "user",
    "content": "責める言い方をすると喧嘩になるので、落ち着いて伝えたいです。"
  },
  {
    "role": "assistant",
    "content": "「私の時間も大切にしたいので、家事を頼んだ時に、いつ対応するかを一緒に決めたいです。」"
  },
  {
    "role": "user",
    "content": "今夜話すなら、最初の一言はどうすればいいですか？"
  },
  {
    "role": "assistant",
    "content": "「私の時間も大切にしたいから、家事を頼んだ時にいつやるかを一緒に決めたいんだけど、今夜少し話せる？」"
  },
  {
    "role": "user",
    "content": "その言い方ならできそうですが、途中で感情的になりそうで不安です。"
  },
  {
    "role": "assistant",
    "content": "途中で感情が強くなりそうなのが不安なんですね。\n\n感情が強いまま話し続けると、伝えたい内容より言い方に意識が向きやすくなります。\n\n話を続けるのが難しいと感じたら、「5分だけ休憩してから続きを話したい」と伝えてください。"
  }
];
const latest = "話す直前にできることを、質問なしで一つだけ教えてください。";
const capturedPublicFinal = "話し始める直前に、最初に伝えたい一文をメモで一度だけ確認してください。";
interface MemoControl { name: string; extra: CoachingChatMessage[]; expectedUngrounded: boolean; currentUserTexts?: string[]; }
const definitions: MemoControl[] = [
  {
    "name": "own-opening-memo-written",
    "extra": [
      {
        "role": "user",
        "content": "最初に伝える一文をメモに書いてあります。"
      }
    ],
    "expectedUngrounded": false
  },
  {
    "name": "own-memo-with-quoted-content",
    "extra": [
      {
        "role": "user",
        "content": "私のメモには「自分の時間も大切にしたい」と書きました。"
      }
    ],
    "expectedUngrounded": false
  },
  {
    "name": "actual-no-memo-readiness",
    "extra": [],
    "expectedUngrounded": true
  },
  {
    "name": "assistant-only-memo",
    "extra": [
      {
        "role": "assistant",
        "content": "最初に伝える一文をメモに書いてあるのですね。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "quoted-ai-nested-memo",
    "extra": [
      {
        "role": "user",
        "content": "AIから「メモには『最初に伝える一文』を書いてあります」と言われました。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "ascii-quoted-ai-memo",
    "extra": [
      {
        "role": "user",
        "content": "AIから \"最初に伝える一文をメモに書きました\" と言われました。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "third-party-memo",
    "extra": [
      {
        "role": "user",
        "content": "夫は最初に伝える一文をメモに書いてあります。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "memo-explicit-not-ready",
    "extra": [
      {
        "role": "user",
        "content": "最初に伝える一文は、まだメモに書いていません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "memo-readiness-revoked",
    "extra": [
      {
        "role": "user",
        "content": "最初に伝える一文をメモに書きました。"
      },
      {
        "role": "user",
        "content": "そのメモは処分して、今は手元にありません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "old-topic-memo-not-current",
    "extra": [
      {
        "role": "user",
        "content": "最初に伝える一文をメモに書きました。"
      },
      {
        "role": "user",
        "content": "話題を変えて、今度は職場での会話について考えたいです。"
      }
    ],
    "expectedUngrounded": true,
    "currentUserTexts": [
      "話題を変えて、今度は職場での会話について考えたいです。",
      "話す直前にできることを、質問なしで一つだけ教えてください。"
    ]
  },
  {
    "name": "memo-future-plan-only",
    "extra": [
      {
        "role": "user",
        "content": "最初に伝える一文は、これからメモに書こうと思っています。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "blank-memo-tool-only",
    "extra": [
      {
        "role": "user",
        "content": "メモ帳はありますが、まだ何も書いていません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "root-memo-wrote",
    "extra": [
      {
        "role": "user",
        "content": "メモを書きました。"
      }
    ],
    "expectedUngrounded": false
  },
  {
    "name": "root-memo-exists-but-empty",
    "extra": [
      {
        "role": "user",
        "content": "メモはありますが、まだ何も書いていません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "root-memo-discarded",
    "extra": [
      {
        "role": "user",
        "content": "メモに一文を書きました。あとでメモを捨てました。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "root-absent-future-write",
    "extra": [
      {
        "role": "user",
        "content": "メモはありませんが、これから書きます。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "root-memo-unknown",
    "extra": [
      {
        "role": "user",
        "content": "メモがあるか分かりません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "root-husband-memo",
    "extra": [
      {
        "role": "user",
        "content": "夫はメモに一文を書きました。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "root-own-memo",
    "extra": [
      {
        "role": "user",
        "content": "私のメモに一文を書きました。"
      }
    ],
    "expectedUngrounded": false
  },
  {
    "name": "review-completion-hypothetical",
    "extra": [
      {
        "role": "user",
        "content": "メモに一文を書いたら確認できます。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "review-completion-report-denial",
    "extra": [
      {
        "role": "user",
        "content": "メモに書きましたとは言っていません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "review-thirdparty-comma",
    "extra": [
      {
        "role": "user",
        "content": "夫は、メモに一文を書きました。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "review-opening-sentence-topic",
    "extra": [
      {
        "role": "user",
        "content": "最初に伝える一文はメモに書いてあります。"
      }
    ],
    "expectedUngrounded": false
  },
  {
    "name": "review-later-short-unwritten",
    "extra": [
      {
        "role": "user",
        "content": "最初に伝える一文をメモに書きました。"
      },
      {
        "role": "user",
        "content": "まだ書いていません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "review-later-memo-no-longer",
    "extra": [
      {
        "role": "user",
        "content": "メモに一文を書きました。"
      },
      {
        "role": "user",
        "content": "メモはもうありません。"
      }
    ],
    "expectedUngrounded": true
  },
  {
    "name": "root-ordered-absence-then-current-creation",
    "extra": [
      {
        "role": "user",
        "content": "メモはありませんでしたが、今メモに一文を書きました。"
      }
    ],
    "expectedUngrounded": false
  },
  {
    "name": "root-completed-disposal-revokes-ready-memo",
    "extra": [
      {
        "role": "user",
        "content": "メモに一文を書きました。"
      },
      {
        "role": "user",
        "content": "メモを処分しました。"
      }
    ],
    "expectedUngrounded": true
  }
];
const ownHistory = history.filter(message => message.role === 'user').map(message => message.content);
const fixture = {history,latest,capturedPublicFinal,diagnosisCode:'MME-3',controls:definitions.map(control => ({name:control.name,history:[...history,...control.extra],latest,candidate:capturedPublicFinal,helperCurrentUserTexts:control.currentUserTexts ?? [...ownHistory,...control.extra.filter(message => message.role === 'user').map(message => message.content),latest],expectedUngrounded:control.expectedUngrounded})),outputControls:[
  {
    "name": "root-direct-memo-read",
    "text": "メモで一度確認してください。",
    "userTexts": [],
    "expected": true,
    "rationale": "Root explicit simple read-candidate control."
  },
  {
    "name": "root-faithful-reported-memo-instruction",
    "text": "「メモで一度確認してください」とAIに言われたのですね。",
    "userTexts": [
      "「メモで一度確認してください」とAIに言われました。"
    ],
    "expected": false,
    "rationale": "Root faithful quoted report, not new current instruction."
  },
  {
    "name": "root-new-quoted-memo-instruction",
    "text": "「メモで一度確認してください」と伝えてください。",
    "userTexts": [],
    "expected": true,
    "rationale": "Root fresh quoted instruction, no quote-only waiver."
  },
  {
    "name": "review-report-content-then-tell",
    "text": "「メモを確認してください」と言われたことを伝えてください。",
    "userTexts": [],
    "expected": false,
    "rationale": "Prod matched quote report does not become a new memo-read instruction."
  },
  {
    "name": "review-quoted-instruction-try",
    "text": "「メモを確認してください」を試してください。",
    "userTexts": [],
    "expected": true,
    "rationale": "Prod same quoted instruction reused as a fresh requested action."
  },
  {
    "name": "review-read-memo",
    "text": "メモを読んでください。",
    "userTexts": [],
    "expected": true,
    "rationale": "Prod same read-consumption family."
  },
  {
    "name": "review-confirm-memo-sentence",
    "text": "メモの一文を確認してください。",
    "userTexts": [],
    "expected": true,
    "rationale": "Prod same read-consumption family."
  },
  {
    "name": "root-retain-v1-mashou-instruction",
    "text": "メモで一度確認しましょう。",
    "userTexts": [],
    "expected": true,
    "rationale": "Root v2 static feedback: preserve v1ましょう directive coverage; no new live case."
  }
]};

const seen: unknown[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => {
 const output = process.env.ACTI_MEMO_REPLAY_OUTPUT;
 if (output) writeFileSync(output, JSON.stringify({scope:'Fixed offline public delivery plus finite memo readiness controls',transport,actuals:seen},null,2), {flag:'wx',mode:0o600});
 expect(transport.provider).toBe(0); expect(transport.alerts).toBe(0); expect(transport.fetch).toBe(0);
});
function assess(text:string,history=fixture.history,latest=fixture.latest){return assessCoachingResponseQuality({text,lastUserText:latest,historyMessages:history});}
function ensure(text:string){const q=assess(text);return ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'local-public-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:q.issues,finalIssues:q.issues},lastUserText:fixture.latest,historyMessages:fixture.history});}
function clean(text:string){expect(text).not.toBe(fixture.capturedPublicFinal);expect(text).not.toMatch(/メモ(?:で|を)[^。！？\n]{0,24}(?:確認|読み返|見返|参照)/);expect(text).toMatch(/直前/);expect(text).toMatch(/話|一文/);expect(text).not.toMatch(/[？?]|明日の朝|という相談ですね|もう一度送って/);expect(assess(text).issues).toEqual([]);}
describe('exact production memo-readiness defect, all original delivery paths',()=>{
 it.each(['minimal','legacy','observe'])('assesses unprovided existing memo in %s',mode=>{
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);const q=assess(fixture.capturedPublicFinal);seen.push({stage:'assess',mode,history:fixture.history,input:fixture.latest,injectedPublicFinal:fixture.capturedPublicFinal,quality:q});expect(q.issues).toContain('ungrounded_task_assumption');
 });
 it.each(['minimal','legacy','observe'])('records direct and normalized verified delivery in %s',mode=>{
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);const raw=fixture.capturedPublicFinal;const normalized=normalizeCoachingOutput(raw,fixture.latest,fixture.history);const direct=ensure(raw);const normalizedVerified=ensure(normalized);const unflagged=ensureVerifiedCoachingResolution({resolution:{text:raw,usage:{},modelName:'same-memo-empty-flags-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:[],finalIssues:[]},lastUserText:fixture.latest,historyMessages:fixture.history});seen.push({stage:'verified-two-paths',mode,history:fixture.history,input:fixture.latest,injectedPublicFinal:raw,normalized,normalizedQuality:assess(normalized),direct,normalizedVerified,unflagged});
  if(mode==='observe'){expect(direct.text).toBe(raw);expect(direct.initialIssues).toContain('ungrounded_task_assumption');expect(unflagged.text).toBe(raw);expect(unflagged.initialIssues).toContain('ungrounded_task_assumption');return;}
  clean(unflagged.text);expect(unflagged.initialIssues).toContain('ungrounded_task_assumption');expect(unflagged.qualitySafetyHold).not.toBe(true);
  clean(direct.text);clean(normalizedVerified.text);expect(direct.qualitySafetyHold).not.toBe(true);expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
 });
 it.each(['minimal','legacy','observe'])('records full mocked stream in %s',async mode=>{
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);vi.stubGlobal('fetch',async()=>{transport.fetch++;throw Error('NETWORK_FORBIDDEN');});transport.raw=fixture.capturedPublicFinal;const callbacks:unknown[]=[];
  const stream=createJsonLineStream({systemPrompt:getContextualizedPrompt(fixture.diagnosisCode),historyMessages:fixture.history,lastUserParts:buildGeminiParts(fixture.latest,[],[]),onDone:async(_usage,completion)=>{callbacks.push(completion);return {};}});
  const reader=stream.getReader();const decoder=new TextDecoder();let body='';while(true){const part=await reader.read();if(part.done)break;body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();const events=body.trim().split('\n').map(line=>JSON.parse(line));const dones=events.filter(e=>e.type==='done');const done=dones[0];seen.push({stage:'mock-fullstream',mode,history:fixture.history,input:fixture.latest,injectedPublicFinal:fixture.capturedPublicFinal,events,callbacks,final:done?.message,done});
  expect(dones).toHaveLength(1);expect(callbacks).toHaveLength(1);expect(done.completionStatus).toBe('complete');expect(done.finalizationStatus).toBe('complete');expect(events.filter(e=>e.type==='chunk').map(e=>e.text).join('')).toBe(done.message);expect((callbacks[0] as {message:string}).message).toBe(done.message);
  if(mode==='observe'){expect(done.message).toBe(fixture.capturedPublicFinal);expect(done.qualityInitialIssues).toContain('ungrounded_task_assumption');}else{clean(done.message);expect(done.qualityFinalIssues).toEqual([]);expect(done.qualitySafetyHold).not.toBe(true);}
  expect(transport).toEqual({raw:fixture.capturedPublicFinal,provider:0,alerts:0,fetch:0});
 });
});
describe('finite current USER artifact evidence controls',()=>{
 it.each(fixture.controls)('$name',(c)=>{
  const helper=containsUngroundedTaskAssumption(c.candidate,c.helperCurrentUserTexts);const quality=assess(c.candidate,c.history,c.latest);seen.push({stage:'grounding-control',...c,helper,quality});expect(helper).toBe(c.expectedUngrounded);expect(quality.issues.includes('ungrounded_task_assumption')).toBe(c.expectedUngrounded);
 });
});

describe('finite reported vs newly instructed memo consumption',()=>{it.each(fixture.outputControls)('$name',c=>{const actual=containsUngroundedTaskAssumption(c.text,c.userTexts);seen.push({stage:'memo-read-output-control',...c,actual});expect(actual).toBe(c.expected);});});


// Fixed LOCAL public-export builder output, not captured provider or production wire.
// New finite offline regressions only. Existing memo44 inputs/assertions are unchanged.
const futurePlanObserved = {
  "history": [
    {
      "role": "assistant",
      "content": "ここからどのように進めるか、考えられそうですか？"
    }
  ],
  "latest": "メモに書いてみます。",
  "candidate": "書き留めながら進めることを考えているのですね。今は計画や課題を増やすより、その手順で一度進め、実際に何が起きるかを確かめる段階です。予定どおりに進まなくても、それは失敗ではなく、次の改善点が分かる材料になります。\n\n新しい課題は足さず、予定している最初の一回だけを実行してください。"
} as {history:CoachingChatMessage[];latest:string;candidate:string};
const futurePlanActuals: unknown[] = [];
afterAll(() => {
 const output = process.env.ACTI_FUTURE_PLAN_REPLAY_OUTPUT;
 if (output) writeFileSync(output, JSON.stringify({
  scope: 'Exact two-input LOCAL public-export future-writing regression; no new live case',
  providerOriginalRaw: 'NOT_CAPTURED', candidateOrigin: 'saved_local_public_export_builder_final',
  actuals: futurePlanActuals,
 }, null, 2) + '\n', {flag:'wx',mode:0o600});
});
function assessFuturePlan(text: string) {
 return assessCoachingResponseQuality({text,lastUserText:futurePlanObserved.latest,historyMessages:futurePlanObserved.history});
}
function ensureFuturePlan(text: string) {
 const quality=assessFuturePlan(text);
 return ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'local-public-export-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:quality.issues,finalIssues:quality.issues},lastUserText:futurePlanObserved.latest,historyMessages:futurePlanObserved.history});
}
function expectFaithfulFutureWritingAcknowledgement(text: string) {
 expect(text).not.toBe(futurePlanObserved.candidate);
 expect(text).toMatch(/メモ|書き留め|記録|書いて|書く/);
 // These are the unprovided frames in the actual fallback, not a global word ban.
 expect(text).not.toMatch(/計画や課題を増やすより|その手順で一度進め|確かめる段階|予定どおりに進まなくても|それは失敗ではなく|改善点が分かる材料|新しい課題は足さず|予定している最初の一回/);
 expect(text).not.toMatch(/紙にある内容|作成済み|書き終えた|メモ(?:で|を)[^。！？\n]{0,24}(?:確認|読み返|見返|参照)/);
 expect(text).not.toMatch(/[？?]|という相談ですね|もう一度送って|時間をおいて/);
 expect(assessFuturePlan(text).issues).toEqual([]);
}
describe('finite future-writing intention without generic stage framing', () => {
 it('builds a grounded acknowledgement for the exact two inputs', () => {
  const final=buildFinalVerifiedQualityFallback(futurePlanObserved.latest,futurePlanObserved.history);
  futurePlanActuals.push({stage:'builder',...futurePlanObserved,final,quality:assessFuturePlan(final)});
  expectFaithfulFutureWritingAcknowledgement(final);
 });
 it.each(['minimal','legacy','observe'])('detects the saved generic builder candidate in %s', mode => {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
  const quality=assessFuturePlan(futurePlanObserved.candidate);
  futurePlanActuals.push({stage:'assess',mode,...futurePlanObserved,quality});
  expect(quality.issues).toContain('generic_canned_close');
 });
 it.each(['minimal','legacy','observe'])('records direct and normalized verification in %s', mode => {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
  const normalized=normalizeCoachingOutput(futurePlanObserved.candidate,futurePlanObserved.latest,futurePlanObserved.history);
  const direct=ensureFuturePlan(futurePlanObserved.candidate);
  const normalizedVerified=ensureFuturePlan(normalized);
  futurePlanActuals.push({stage:'verified-two-paths',mode,...futurePlanObserved,normalized,normalizedQuality:assessFuturePlan(normalized),direct,normalizedVerified});
  if(mode==='observe'){
   expect(direct.text).toBe(futurePlanObserved.candidate);
   expect(direct.initialIssues).toContain('generic_canned_close');
   expectFaithfulFutureWritingAcknowledgement(normalizedVerified.text);
   expect(normalizedVerified.finalIssues).toEqual([]);
   return; // Known-bad detection only; never semantic delivery PASS.
  }
  expectFaithfulFutureWritingAcknowledgement(direct.text);
  expectFaithfulFutureWritingAcknowledgement(normalizedVerified.text);
  expect(direct.finalIssues).toEqual([]);expect(normalizedVerified.finalIssues).toEqual([]);
  expect(direct.qualitySafetyHold).not.toBe(true);expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
 });
 it.each(['minimal','legacy','observe'])('records full mock delivery of the same candidate in %s',async mode=>{
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
  vi.stubGlobal('fetch',async()=>{transport.fetch++;throw Error('NETWORK_FORBIDDEN');});
  transport.raw=futurePlanObserved.candidate;
  const callsBefore={...futurePlanMockCalls};const callbacks:Array<{message:string}>=[];
  const reader=createJsonLineStream({systemPrompt:getContextualizedPrompt('MME-3'),historyMessages:futurePlanObserved.history,lastUserParts:buildGeminiParts(futurePlanObserved.latest,[],futurePlanObserved.history),onDone:async(_usage,value)=>{callbacks.push(value);return {};}}).getReader();
  const decoder=new TextDecoder();let wire='';
  while(true){const part=await reader.read();if(part.done)break;wire+=decoder.decode(part.value,{stream:true});}wire+=decoder.decode();
  const events=wire.trim().split('\n').map(line=>JSON.parse(line));
  const dones=events.filter(event=>event.type==='done');const done=dones[0];
  const mockCallDelta={primary:futurePlanMockCalls.primary-callsBefore.primary,repair:futurePlanMockCalls.repair-callsBefore.repair};
  futurePlanActuals.push({stage:'mock-fullstream',mode,...futurePlanObserved,
   configuredMockCandidate:futurePlanObserved.candidate,
   candidateOrigin:'saved_local_public_export_builder_final_not_provider_original',
   diagnosisProvenance:'MME-3 reused from existing memo offline harness, not an observed production diagnosis for this adjacent case',
   mockCallDelta,
   configuredCandidateConsumption:mockCallDelta.primary>0?'primary_consumed':mockCallDelta.repair>0?'repair_only_consumed':'not_consumed_local_immediate',
   wire,events,callbacks,done,final:done?.message,
   forbidden:{provider:transport.provider,alerts:transport.alerts,fetch:transport.fetch}});
  expect(dones).toHaveLength(1);expect(callbacks).toHaveLength(1);
  expect(done.completionStatus).toBe('complete');expect(done.finalizationStatus).toBe('complete');
  expect(events.filter(event=>event.type==='chunk').map(event=>event.text).join('')).toBe(done.message);
  expect(callbacks[0].message).toBe(done.message);
  expect(transport.provider).toBe(0);expect(transport.alerts).toBe(0);expect(transport.fetch).toBe(0);
  if(mockCallDelta.primary>0){
   expect(done.qualityInitialIssues).toContain('generic_canned_close');
   if(mode==='observe'){expect(done.message).toBe(futurePlanObserved.candidate);return;}
  }else{
   // A correct local immediate acknowledgement never consumed the configured bad candidate.
   // Verify actual content in every mode rather than calling an unexercised raw repair PASS.
   expect(mockCallDelta.repair).toBe(0);
  }
  expectFaithfulFutureWritingAcknowledgement(done.message);
  expect(done.qualityFinalIssues).toEqual([]);expect(done.qualitySafetyHold).not.toBe(true);
 });

 it.each([
  {name:'intended-communication-memo',latest:'夫に伝える一文をメモに書いてみます。',ack:/メモ|書き留め|記録|書いて|書く/},
  {name:'intended-trial-without-preparation',latest:'やってみます。',ack:/やってみ|試してみ/},
 ])('acknowledges $name without the known unprovided process framing',c=>{
  const final=buildFinalVerifiedQualityFallback(c.latest,futurePlanObserved.history);
  const quality=assessCoachingResponseQuality({text:final,lastUserText:c.latest,historyMessages:futurePlanObserved.history});
  futurePlanActuals.push({stage:'builder-commitment-control',name:c.name,history:futurePlanObserved.history,latest:c.latest,final,quality,
   expectedScope:'Future intention only, no completed conversation reaction, prepared artifact, generic process stage or extra unspecified execution target.'});
  expect(final).toMatch(c.ack);
  expect(final).not.toMatch(/相手との会話で何が伝わったかを残す方針|実際の反応を次の判断材料|本人が受け取った事実が分かる|相手との会話で伝わったことを一文だけ書き出|準備したことを実際に試しながら|その方針で一度進め|計画や課題を増やすより|その手順で一度進め|確かめる段階|予定どおりに進まなくても|それは失敗ではなく|改善点が分かる材料|次に見直す手順が分かる材料|新しい課題は足さず|予定している最初の一回/);
  expect(final).not.toMatch(/紙にある内容|作成済み|書き終えた|メモ(?:で|を)[^。！？\n]{0,24}(?:確認|読み返|見返|参照)/);
  expect(final).not.toMatch(/[？?]|という相談ですね|もう一度送って|時間をおいて/);
  expect(quality.issues).toEqual([]);
 });
 it('does not classify the faithful future acknowledgement as generic filler',()=>{
  const candidate='メモに書いてみるのですね。';const quality=assessFuturePlan(candidate);
  futurePlanActuals.push({stage:'faithful-ack-classification-control',...futurePlanObserved,candidate,quality,
   expectationScope:'Only no generic_canned_close; unrelated shortness is recorded, not silently called full quality PASS.'});
  expect(quality.issues).not.toContain('generic_canned_close');
 });
});


// Four additional finite LOCAL controls from the original before run and raw newline guard.
const futurePlanObservedPartial = "書き留めながら進めることを考えているのですね。今は計画や課題を増やすより、その手順で一度進め、実際に何が起きるかを確かめる段階です。\n\n新しい課題は足さず、予定している最初の一回だけを実行してください。";
describe('observed partial future-intention template and raw newline boundary',()=>{
 it.each(['minimal','legacy','observe'])('verifies the saved partial template in %s',mode=>{
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
  const candidate=futurePlanObservedPartial;
  const quality=assessFuturePlan(candidate);
  const normalized=normalizeCoachingOutput(candidate,futurePlanObserved.latest,futurePlanObserved.history);
  const direct=ensureFuturePlan(candidate);const normalizedVerified=ensureFuturePlan(normalized);
  futurePlanActuals.push({stage:'observed-partial-template',mode,history:futurePlanObserved.history,latest:futurePlanObserved.latest,
   candidate,candidateOrigin:'exact_normalized_field_from_saved_LOCAL_before_minimal_verification_not_provider_raw',
   quality,normalized,normalizedQuality:assessFuturePlan(normalized),direct,normalizedVerified});
  expect(quality.issues).toContain('generic_canned_close');
  expect(direct.initialIssues).toContain('generic_canned_close');
  expectFaithfulFutureWritingAcknowledgement(normalizedVerified.text);
  expect(normalizedVerified.finalIssues).toEqual([]);expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
  if(mode==='observe'){
   expect(direct.text).toBe(candidate);
   return; // Direct observe is known-bad detection, explicit normalization is a separate pure path.
  }
  expectFaithfulFutureWritingAcknowledgement(direct.text);
  expect(direct.finalIssues).toEqual([]);expect(direct.qualitySafetyHold).not.toBe(true);
 });
 it('does not classify a newline-split input as the eligible whole future clause',()=>{
  const latest='メモに\n書いてみます。';
  const candidates=['メモに書いてみるのですね。','メモに 書いてみるのですね。'];
  const assessments=candidates.map(candidate=>({candidate,quality:assessCoachingResponseQuality({text:candidate,lastUserText:latest,historyMessages:futurePlanObserved.history})}));
  futurePlanActuals.push({stage:'raw-newline-eligibility-boundary',history:futurePlanObserved.history,latest,assessments,
   expectationScope:'Both candidate renderings retain too_short. The spaced form catches newline loss before the eligibility helper; no overall reply-quality PASS is claimed.'});
  for(const item of assessments) expect(item.quality.issues).toContain('too_short');
 });
});


// Exact R2 T5 public delivery, not provider-original generation.
const purposePlanObserved = {
  "history": [
    {
      "role": "user",
      "content": "新しい企画の説明資料を作っています。"
    },
    {
      "role": "assistant",
      "content": "企画の説明資料を作っているのですね。最初に読み手と資料の目的を決めると、載せる情報や説明の順番を選びやすくなります。すでに内容を書き始めていても、読み手が知っていることと、資料で初めて知ることを分けて確認できます。\n\nその資料は、誰に何を伝えるためのものですか？"
    },
    {
      "role": "user",
      "content": "対象は初めてサービスを使う人です。"
    },
    {
      "role": "assistant",
      "content": "企画の説明資料を読むのは、初めてサービスを使う人なのですね。読者が仕組みや用語を知っている前提を置かず、「何ができるか」「最初に何をするか」の順で説明すると理解しやすくなります。機能をすべて紹介する前に、読者が最初に達成したいことを決めると、必要な説明を選べます。\n\nその資料を読んだ人に、まず何ができるようになってほしいですか？"
    },
    {
      "role": "user",
      "content": "専門用語を減らしたいです。"
    },
    {
      "role": "assistant",
      "content": "資料の専門用語を減らしたいのですね。言葉を日常的な表現や具体的な動作に置き換えると、初めて使う人にも内容が伝わりやすくなります。資料全体を一度に変えず、一つの用語から言い換えを考えられます。\n\n今の資料で、まず言い換えたい専門用語は何ですか？"
    },
    {
      "role": "user",
      "content": "説明する順番にも迷っています。"
    },
    {
      "role": "assistant",
      "content": "初めてサービスを使う人に向けて、説明する順番を整理したいのですね。専門用語を減らすことと合わせて、全体の流れも整えたい状況とお見受けします。\n\n読者が迷わず理解できるように、説明の順番を以下のように組み立ててみてください。\n\n1. このサービスで何ができるか（得られる変化やメリット）\n2. 使うために、まず何をするか（最初の1ステップ）\n3. 具体的な手順や機能の説明\n\nまずは「何ができるか」を伝えることで読者の興味を引き、その次に「最初にやること」を示すと、ハードルを感じずに読み進めてもらえます。\n\nこの全体の流れについて、イメージに合いそうか聞かせてもらえますか？"
    }
  ],
  "latest": "一枚目には利用目的を書く予定です。",
  "candidate": "1枚目に利用目的を書く予定なのですね。初めてサービスを使う人が「自分に関係がある」と感じられる導入になります。\n\n利用目的の文で使っている専門用語を一つ選び、日常的な言葉に書き換えてみてください。"
} as { history: CoachingChatMessage[]; latest: string; candidate: string };
const purposePlanActuals: unknown[] = [];
const purposePlanControls = [
  {
    "id": "faithful-future-ack",
    "latest": "一枚目には利用目的を書く予定です。",
    "candidate": "一枚目には利用目的を書く予定なのですね。",
    "expected": "Faithful own future acknowledgement may be delivered unchanged; no claim it has been written, no extra task.",
    "assertionScope": "full meaningful final, exact source proposition; short exact ack exemption scoped only to matching own intention"
  },
  {
    "id": "future-conditional-advice",
    "latest": "一枚目には利用目的を書く予定です。",
    "candidate": "これから利用目的を書く際には、専門用語を使わず日常的な言葉で表せます。",
    "expected": "Do not flag as existing purpose-text premise; genuinely prospective advice.",
    "assertionScope": "target grounding guard only; record all other quality issues without calling limited control whole-pass"
  },
  {
    "id": "future-if-term-advice",
    "latest": "一枚目には利用目的を書く予定です。",
    "candidate": "利用目的の文で使っている専門用語があれば、日常的な言葉に置き換えられます。",
    "expected": "This exact used-term phrase is conditional on whether the term exists; not an unconditional completed draft assertion.",
    "assertionScope": "target grounding guard only"
  },
  {
    "id": "own-completed-explicit-term",
    "latest": "一枚目に利用目的を書きました。専門用語も使っています。",
    "candidate": "利用目的の文で使っている専門用語を、日常的な言葉に書き換えてください。",
    "expected": "Own same-purpose text and term usage explicitly reported; target existing-artifact guard must allow.",
    "assertionScope": "target grounding guard only; do not broadly waive all quality issues"
  },
  {
    "id": "explicit-supplied-draft-edit",
    "latest": "一枚目の利用目的は「情報共有を円滑にすること」と書く予定です。この文を添削してください。",
    "candidate": "「情報共有」を「情報を伝え合うこと」に置き換えられます。",
    "expected": "Provided draft and explicit editing request permit use of actual quoted wording; no forced acknowledgment that ignores request.",
    "assertionScope": "preserve supplied wording/edit request, no whole-clause intention eligibility"
  },
  {
    "id": "third-party-planned-writing",
    "latest": "同僚は一枚目に利用目的を書く予定です。",
    "candidate": "同僚が一枚目に利用目的を書く予定なのですね。",
    "expected": "Faithful third-party report preserved; do not convert to user intention or grant own-intention short waiver.",
    "assertionScope": "actor and eligibility only; other length issues remain visible"
  },
  {
    "id": "reported-quoted-plan",
    "latest": "担当者から「一枚目には利用目的を書く予定です」と言われました。",
    "candidate": "担当者から、一枚目には利用目的を書く予定だと言われたのですね。",
    "expected": "Quoted reported plan is not own future action; preserve attribution and do not force own acknowledgment.",
    "assertionScope": "attribution and own-intention ineligibility only"
  },
  {
    "id": "topic-switch-after-document",
    "latest": "話題を変えて、友人への返事を考えたいです。",
    "candidate": "友人への返事について、何を伝えたいですか？",
    "expected": "Current new topic takes precedence over old planning history; no purpose/artifact repair or old-topic acknowledgment.",
    "assertionScope": "topic scope and target guard only"
  },
  {
    "id": "own-plan-negated",
    "latest": "一枚目に利用目的を書く予定ではありません。",
    "candidate": "一枚目に利用目的を書く予定ではないのですね。",
    "expected": "Do not detect affirmative future plan or rewrite to positive acknowledgment.",
    "assertionScope": "affirmative eligibility and faithful negation only"
  },
  {
    "id": "plan-question-not-commitment",
    "latest": "一枚目に利用目的を書く予定でよいでしょうか？",
    "candidate": "利用目的を一枚目に置く案について考えているのですね。",
    "expected": "A question is not a committed future act; existing question path remains, no automatic positive ack.",
    "assertionScope": "own-intention ineligibility only"
  }
] as const;
afterAll(() => {
 const output=process.env.ACTI_PURPOSE_PLAN_REPLAY_OUTPUT;
 if(output) writeFileSync(output,JSON.stringify({scope:'Exact a871 R2 T5 plus ten finite writing-plan controls; public delivery injection, provider original NOT_CAPTURED',actuals:purposePlanActuals},null,2)+'\n',{flag:'wx',mode:0o600});
});
function assessPurpose(text: string, latest=purposePlanObserved.latest) {
 return assessCoachingResponseQuality({text,lastUserText:latest,historyMessages:purposePlanObserved.history});
}
function ensurePurpose(text: string) {
 const q=assessPurpose(text);
 return ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'saved-public-delivery-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:q.issues,finalIssues:q.issues},lastUserText:purposePlanObserved.latest,historyMessages:purposePlanObserved.history});
}
function expectGroundedPurposePlan(text: string) {
 expect(text).toContain('利用目的');expect(text).toMatch(/書く予定/);
 expect(text).not.toMatch(/使っている専門用語|文で使った|書き換えて|書き終え|作成済み|という相談|改善点|失敗|新しい課題/);
 expect(text).not.toMatch(/[？?]|ください|ましょう/);
 expect(assessPurpose(text).issues).toEqual([]);
}
describe('observed future-purpose writing plan keeps artifact temporal grounding',()=>{
 it('rejects the exact captured existing-purpose-text premise before repair',()=>{
  const q=assessPurpose(purposePlanObserved.candidate);purposePlanActuals.push({stage:'assess-captured',...purposePlanObserved,quality:q});
  expect(q.issues).toContain('context_mismatch');
 });
 it('builds only the stated future-purpose intention without an existing draft',()=>{
  const final=buildFinalVerifiedQualityFallback(purposePlanObserved.latest,purposePlanObserved.history);purposePlanActuals.push({stage:'builder',...purposePlanObserved,final,quality:assessPurpose(final)});expectGroundedPurposePlan(final);
 });
 it.each(['minimal','legacy','observe'])('verifies the actual direct and normalized paths in %s',mode=>{
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
  const candidate=purposePlanObserved.candidate;const normalized=normalizeCoachingOutput(candidate,purposePlanObserved.latest,purposePlanObserved.history);const direct=ensurePurpose(candidate);const normalizedVerified=ensurePurpose(normalized);
  purposePlanActuals.push({stage:'verified-two-paths',mode,...purposePlanObserved,normalized,normalizedQuality:assessPurpose(normalized),direct,normalizedVerified});
  expectGroundedPurposePlan(normalizedVerified.text);
  if(mode==='observe'){expect(direct.text).toBe(candidate);expect(direct.initialIssues).toContain('context_mismatch');return;}
  expectGroundedPurposePlan(direct.text);expect(direct.finalIssues).toEqual([]);expect(direct.qualitySafetyHold).not.toBe(true);expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
 });
 it.each(['minimal','legacy','observe'])('records exact MGA-3 public-candidate fullstream in %s',async mode=>{
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);vi.stubGlobal('fetch',async()=>{transport.fetch++;throw Error('NETWORK_FORBIDDEN');});transport.raw=purposePlanObserved.candidate;const before={...futurePlanMockCalls};const callbacks:Array<{message:string}>=[];
  const reader=createJsonLineStream({systemPrompt:getContextualizedPrompt('MGA-3'),historyMessages:purposePlanObserved.history,lastUserParts:buildGeminiParts(purposePlanObserved.latest,[],purposePlanObserved.history),onDone:async(_usage,value)=>{callbacks.push(value);return {};}}).getReader();
  const decoder=new TextDecoder();let wire='';while(true){const p=await reader.read();if(p.done)break;wire+=decoder.decode(p.value,{stream:true});}wire+=decoder.decode();
  const events=wire.trim().split('\n').map(line=>JSON.parse(line));const dones=events.filter(e=>e.type==='done');const done=dones[0];const mockCallDelta={primary:futurePlanMockCalls.primary-before.primary,repair:futurePlanMockCalls.repair-before.repair};
  purposePlanActuals.push({stage:'mock-fullstream',mode,...purposePlanObserved,candidateOrigin:'a871 R2 T5 saved public delivery, NOT provider original',diagnosisCode:'MGA-3',mockCallDelta,configuredCandidateConsumption:mockCallDelta.primary>0?'primary_consumed':mockCallDelta.repair>0?'repair_only_consumed':'not_consumed_local_immediate',wire,events,done,callbacks,final:done?.message,forbidden:{provider:transport.provider,fetch:transport.fetch,alerts:transport.alerts}});
  expect(dones).toHaveLength(1);expect(callbacks).toHaveLength(1);expect(done.completionStatus).toBe('complete');expect(done.finalizationStatus).toBe('complete');expect(events.filter(e=>e.type==='chunk').map(e=>e.text).join('')).toBe(done.message);expect(callbacks[0].message).toBe(done.message);
  expect(transport.provider).toBe(0);expect(transport.fetch).toBe(0);expect(transport.alerts).toBe(0);
  if(mode==='observe'&&mockCallDelta.primary>0){expect(done.message).toBe(purposePlanObserved.candidate);expect(done.qualityInitialIssues).toContain('context_mismatch');return;}
  expectGroundedPurposePlan(done.message);expect(done.qualityFinalIssues).toEqual([]);expect(done.qualitySafetyHold).not.toBe(true);
 });
 it.each(purposePlanControls)('preserves finite $id boundary',c=>{
  const quality=assessPurpose(c.candidate,c.latest);const normalized=normalizeCoachingOutput(c.candidate,c.latest,purposePlanObserved.history);
  purposePlanActuals.push({stage:'finite-control',...c,history:purposePlanObserved.history,quality,normalized});
  // Only this grounding/eligibility boundary, never a blanket quality PASS.
  expect(quality.issues).not.toContain('context_mismatch');
  if(c.id==='faithful-future-ack')expectGroundedPurposePlan(c.candidate);
  if(c.id==='third-party-planned-writing') {
   const normalizedQuality=assessPurpose(normalized,c.latest);
   const normalizedVerified=ensureVerifiedCoachingResolution({resolution:{text:normalized,usage:{},modelName:'same-third-party-normalized-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:normalizedQuality.issues,finalIssues:normalizedQuality.issues},lastUserText:c.latest,historyMessages:purposePlanObserved.history});
   const finalQuality=assessPurpose(normalizedVerified.text,c.latest);
   const directBuilder=buildFinalVerifiedQualityFallback(c.latest,purposePlanObserved.history);purposePlanActuals.push({stage:'same-third-party-builder-diagnostics',history:purposePlanObserved.history,latest:c.latest,candidate:c.candidate,directBuilder,quality:assessPurpose(directBuilder,c.latest)});
   purposePlanActuals.push({stage:'same-third-party-normalized-ensure',history:purposePlanObserved.history,latest:c.latest,candidate:c.candidate,normalized,normalizedQuality,normalizedVerified,final:normalizedVerified.text,finalQuality,assertionScope:'Same existing third-party input; actual normalized-to-ensure path, no unsupported request to change that person'});
   expect(normalizedVerified.text).not.toMatch(/その相手に[、,]?まずどの行動を変えてほしい|相手に変えてほしい行動/);
   expect(normalizedVerified.text).toContain('同僚が一枚目に利用目的を書く予定なのですね');
   expect(normalizedVerified.text).toContain('その予定について、あなたはどの点を相談したいですか？');
   expect((normalizedVerified.text.match(/のですね/g)||[]).length).toBeLessThan(3);
   expect(finalQuality.issues).toEqual([]);
   const observedBad=c.candidate+'\n\nその相手に、まずどの行動を変えてほしいですか？';
   expect(assessPurpose(observedBad,c.latest).issues).toContain('context_mismatch');
   for(const mode of ['minimal','legacy','observe']) {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
    const emptyFlagsVerified=ensureVerifiedCoachingResolution({resolution:{text:observedBad,usage:{},modelName:'same-third-party-empty-flags-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:[],finalIssues:[]},lastUserText:c.latest,historyMessages:purposePlanObserved.history});
    purposePlanActuals.push({stage:'same-third-party-empty-flags-ensure',mode,history:purposePlanObserved.history,latest:c.latest,candidate:observedBad,verified:emptyFlagsVerified,final:emptyFlagsVerified.text,finalQuality:assessPurpose(emptyFlagsVerified.text,c.latest)});
    if(mode==='observe'){expect(emptyFlagsVerified.text).toBe(observedBad);expect(emptyFlagsVerified.initialIssues).toContain('context_mismatch');}
    else {expect(emptyFlagsVerified.text).toBe(normalizedVerified.text);expect(emptyFlagsVerified.finalIssues).toEqual([]);expect(emptyFlagsVerified.qualitySafetyHold).not.toBe(true);}
   }
  }
  if(c.id==='future-conditional-advice'||c.id==='future-if-term-advice')expect(normalized).toBe(c.candidate);
  if(['third-party-planned-writing','reported-quoted-plan','own-plan-negated','plan-question-not-commitment'].includes(c.id))expect(quality.issues).toContain('too_short');
  if(c.id==='own-plan-negated') {
   const outputDenial='利用目的の文で使っている専門用語があるとは、まだ言えません。';const q=assessPurpose(outputDenial);
   purposePlanActuals.push({stage:'same-negation-boundary-output',history:purposePlanObserved.history,latest:purposePlanObserved.latest,candidate:outputDenial,quality:q,assertionScope:'Only no context_mismatch, not whole-quality PASS'});
   expect(q.issues).not.toContain('context_mismatch');
   const h=[...purposePlanObserved.history.slice(0,-1),{role:'user' as const,content:'利用目的を書きました。'},{role:'user' as const,content:'利用目的を書いていません。'},purposePlanObserved.history.at(-1)!];
   const revoked=assessCoachingResponseQuality({text:purposePlanObserved.candidate,lastUserText:purposePlanObserved.latest,historyMessages:h});
   purposePlanActuals.push({stage:'same-artifact-ready-explicitly-revoked',history:h,latest:purposePlanObserved.latest,candidate:purposePlanObserved.candidate,quality:revoked,assertionScope:'Later explicit not-written cancels own earlier completion; no new scenario ID'});
   expect(revoked.issues).toContain('context_mismatch');
  }
  if(c.id==='reported-quoted-plan') {
   const h=[...purposePlanObserved.history.slice(0,-1),{role:'user' as const,content:'"利用目的を書きました"'},purposePlanObserved.history.at(-1)!];
   const q=assessCoachingResponseQuality({text:purposePlanObserved.candidate,lastUserText:purposePlanObserved.latest,historyMessages:h});
   purposePlanActuals.push({stage:'same-quotation-boundary-ready-evidence',history:h,latest:purposePlanObserved.latest,candidate:purposePlanObserved.candidate,quality:q,assertionScope:'Quoted completion is not own ready-draft evidence'});
   expect(q.issues).toContain('context_mismatch');
   for(const item of [{id:'standalone',candidate:`「${purposePlanObserved.candidate}」`,expected:true},{id:'faithful-report',candidate:`担当者から「${purposePlanObserved.candidate}」と言われたのですね。`,expected:false}]) {
    const history=item.id==='faithful-report'?[...purposePlanObserved.history.slice(0,-1),{role:'user' as const,content:`担当者から「${purposePlanObserved.candidate}」と言われました。`},purposePlanObserved.history.at(-1)!]:purposePlanObserved.history;
    const quality=assessCoachingResponseQuality({text:item.candidate,lastUserText:purposePlanObserved.latest,historyMessages:history});
    purposePlanActuals.push({stage:'same-purpose-instruction-quote-scope',...item,history,latest:purposePlanObserved.latest,quality,reportGroundingCorrected:item.id==='faithful-report',assertionScope:'Only this premise; reported quote is actually supplied by USER in this control, not a new instruction'});
    expect(quality.issues.includes('context_mismatch')).toBe(item.expected);
   }
  }
 });
});
