import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ raw: '', provider: 0, alerts: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
 sendMessageStream: async () => ({stream:(async function*(){yield{text:()=>transport.raw};})(),response:Promise.resolve({candidates:[{finishReason:'STOP'}],usageMetadata:{totalTokenCount:2}})}),
 sendMessage: async () => ({response:{text:()=>transport.raw,candidates:[{finishReason:'STOP'}]}}),
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates',()=>({generateCoachingProviderCandidate:async()=>{transport.provider++;throw Error('PROVIDER_FORBIDDEN');}}));
vi.mock('@/lib/coaching-alerts',()=>({sendCoachingAlert:async()=>{transport.alerts++;throw Error('ALERT_FORBIDDEN');}}));
import { assessCoachingResponseQuality, ensureVerifiedCoachingResolution, normalizeCoachingOutput, buildGeminiParts, createJsonLineStream } from "../src/lib/coaching-gemini";
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
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);const raw=fixture.capturedPublicFinal;const normalized=normalizeCoachingOutput(raw,fixture.latest,fixture.history);const direct=ensure(raw);const normalizedVerified=ensure(normalized);seen.push({stage:'verified-two-paths',mode,history:fixture.history,input:fixture.latest,injectedPublicFinal:raw,normalized,normalizedQuality:assess(normalized),direct,normalizedVerified});
  if(mode==='observe'){expect(direct.text).toBe(raw);expect(direct.initialIssues).toContain('ungrounded_task_assumption');return;}
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
