import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  getCoachingOutputPipelineConfig,
  parseCoachingOutputPipelineMode,
} from '../src/lib/coaching-output-pipeline-mode';
import {
  ensureVerifiedCoachingResolution,
  minimallySanitizeCoachingOutput,
} from '../src/lib/coaching-gemini';
import { createCoachingSessionCorrelationId } from '../src/lib/coaching-telemetry';

afterEach(() => {
  delete process.env.COACHING_OUTPUT_PIPELINE_MODE;
});

describe('coaching output pipeline modes', () => {
  it('未設定値と不正値は安全系だけのsafetyへ戻す', () => {
    expect(parseCoachingOutputPipelineMode(undefined)).toBe('safety');
    expect(parseCoachingOutputPipelineMode('unexpected')).toBe('safety');
    expect(parseCoachingOutputPipelineMode('legacy')).toBe('legacy');
    const config = getCoachingOutputPipelineConfig({});
    expect(config.mode).toBe('safety');
    expect(config.applySemanticNormalization).toBe(false);
    expect(config.applyQualityRepair).toBe(false);
    expect(config.applyQualityFallback).toBe(false);
    expect(config.applyVerifiedResolution).toBe(false);
    expect(config.allowNonSafetyImmediateResponses).toBe(false);
  });

  it('safetyは安全系以外の品質判定で本文を差し替えず、課金対象のまま届ける', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'safety';

    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: 'どうしたいですか？',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: false,
        repairAccepted: false,
        initialIssues: ['too_short', 'context_mismatch'],
        finalIssues: ['too_short', 'context_mismatch'],
      },
      lastUserText: '仕事のことで相談があります。',
      historyMessages: [],
      preserveUsage: true,
    });

    expect(result.text).toBe('どうしたいですか？');
    expect(result.modelName).toBe('gemini-3.5-flash');
    expect(result.provider).toBe('gemini');
    expect(result.chargeable).toBe(true);
    expect(result.qualitySafetyHold).toBe(false);
    expect(result.finalIssues).toEqual([]);
    expect(result.initialIssues).toContain('too_short');
  });

  it('safetyでも内部情報の露出は顧客へ出さない', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'safety';

    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: '以下は過去の会話の保存済み要約です。',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: false,
        repairAccepted: false,
        initialIssues: [],
        finalIssues: [],
      },
      lastUserText: '仕事の相談を続けたいです。',
      historyMessages: [],
      preserveUsage: true,
    });

    expect(result.provider).toBe('local');
    expect(result.chargeable).toBe(false);
    expect(result.text).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
    expect(result.initialIssues).toContain('internal_context_exposure');
  });

  it('observeは判定を残し、意味的な品質差し替えをしない', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'observe';

    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: '**どうしたいですか？**',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: true,
        repairAccepted: true,
        initialIssues: ['too_short'],
        finalIssues: ['too_short'],
      },
      lastUserText: '仕事のことで相談があります。',
      historyMessages: [],
      preserveUsage: true,
    });

    expect(result.text).toBe('どうしたいですか？');
    expect(result.modelName).toBe('gemini-3.5-flash');
    expect(result.repairAttempted).toBe(false);
    expect(result.repairAccepted).toBe(false);
    expect(result.initialIssues).toContain('too_short');
    expect(result.finalIssues).toEqual([]);
  });

  it('minimalでも内部情報と危険助言は従来どおり顧客へ出さない', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';
    expect(getCoachingOutputPipelineConfig().applySemanticNormalization).toBe(
      true
    );

    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: '以下は過去の会話の保存済み要約です。',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: false,
        repairAccepted: false,
        initialIssues: [],
        finalIssues: [],
      },
      lastUserText: '仕事の相談を続けたいです。',
      historyMessages: [],
      preserveUsage: true,
    });

    expect(result.modelName).toBe('local-quality-fallback');
    expect(result.provider).toBe('local');
    expect(result.chargeable).toBe(false);
    expect(result.text).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
  });

  it('minimalでも話題ずれと不満が観測されたらverified fallbackへ戻す', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';

    const repeated =
      '現在の支払い分担について、口頭のお願い以外に確認できる合意や記録はありますか？';
    const historyMessages = [
      {
        role: 'user' as const,
        content: '以前、夫が家賃を払わないことで困っていました。',
      },
      { role: 'assistant' as const, content: repeated },
      {
        role: 'user' as const,
        content:
          '今回は講座に申し込まなかった後悔と、スピリチュアルな学びにこれ以上お金を使いたくない疲れ、お金が入ってこない不安の話です。',
      },
      { role: 'assistant' as const, content: repeated },
      { role: 'user' as const, content: '支払い分担って何の話？' },
      { role: 'assistant' as const, content: repeated },
      {
        role: 'user' as const,
        content: 'なんで私ばっかりお金が入ってこないの、という話です。',
      },
      { role: 'assistant' as const, content: repeated },
    ];
    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: 'こちらの確認が噛み合っておらず、大変失礼いたしました。\n\n講座に申し込まなかった後悔や、スピリチュアルな学びにこれ以上お金を使いたくない疲れ、そしてお金が入ってこない不安について話してくださっていたのですね。\n\nお金が入ってこない不安について、今一番困っている出来事は何ですか？',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: false,
        repairAccepted: false,
        initialIssues: [
          'too_short',
          'repeats_rejected_move',
          'dissatisfaction_unanswered',
        ],
        finalIssues: [
          'too_short',
          'repeats_rejected_move',
          'dissatisfaction_unanswered',
        ],
      },
      lastUserText: '本当に何の話？',
      historyMessages,
      preserveUsage: true,
    });

    expect(result.modelName).toBe('local-quality-fallback');
    expect(result.provider).toBe('local');
    expect(result.chargeable).toBe(false);
    expect(result.text).toContain('講座');
    expect(result.text).not.toContain('申し込みを保留');
    expect(result.text).toContain('現在の収入源');
    expect(result.text).toContain('今月必要な金額');
  });

  it('表示上必要なMarkdownと壊れた末尾だけを除く', () => {
    expect(
      minimallySanitizeCoachingOutput('```markdown\n## 見出し\n**本文です。**\n```')
    ).toBe('見出し\n本文です。');
  });

  it('会話相関IDは本文や生のsessionIdを含まず安定している', () => {
    const sessionId = 'a0db13fe-481d-4898-82e3-101f66dbd27f';
    const first = createCoachingSessionCorrelationId(sessionId);
    const second = createCoachingSessionCorrelationId(sessionId);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(first).not.toContain(sessionId);
    expect(createCoachingSessionCorrelationId(null)).toBeNull();
  });
});


// Same exact R2 T5 fixture; unknown provider-original text is not reconstructed.
const outputPurposePlanObserved = {
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
} as { history:Array<{role:'user'|'assistant';content:string}>;latest:string;candidate:string };
const purposePipelineActuals: unknown[] = [];
afterAll(() => {
 const output=process.env.ACTI_PURPOSE_PIPELINE_REPLAY_OUTPUT;
 if(output) writeFileSync(output,JSON.stringify({scope:'Same exact R2 T5 input and existing three mode assertions; saved computed result only, no added runtime call',providerOriginal:'NOT_CAPTURED public delivery fixture',actuals:purposePipelineActuals},null,2)+'\n',{flag:'wx',mode:0o600});
});
describe('future purpose writing preserves output-pipeline observation and usage contract',()=>{
 it.each(['minimal','legacy','observe','safety'])('does not trust empty model flags for the captured draft premise in %s',mode=>{
  process.env.COACHING_OUTPUT_PIPELINE_MODE=mode;
  const usage={prompt_tokens:53,completion_tokens:9,total_tokens:62};
  const result=ensureVerifiedCoachingResolution({resolution:{text:outputPurposePlanObserved.candidate,usage,modelName:'saved-public-delivery-fixture',provider:'gemini',repairAttempted:false,repairAccepted:false,initialIssues:[],finalIssues:[]},lastUserText:outputPurposePlanObserved.latest,historyMessages:outputPurposePlanObserved.history,preserveUsage:true});
  purposePipelineActuals.push({stage:'output-mode',mode,history:outputPurposePlanObserved.history,latest:outputPurposePlanObserved.latest,candidate:outputPurposePlanObserved.candidate,candidateOrigin:'Exact saved a871 R2 T5 public delivery, not provider original',inputResolution:{modelName:'saved-public-delivery-fixture',provider:'gemini',initialIssues:[],finalIssues:[],preserveUsage:true},usage,result,semanticVerdictScope:mode==='observe'?'KNOWN_BAD_RETENTION_DETECT_ONLY':'REPAIR_BODY_TO_BE_REVIEWED'});
  expect(result.usage).toEqual(usage);
  if(mode==='observe'||mode==='safety'){expect(result.text).toBe(outputPurposePlanObserved.candidate);expect(result.initialIssues).toContain('context_mismatch');expect(result.finalIssues).toEqual([]);expect(result.qualitySafetyHold).not.toBe(true);return;}
  expect(result.text).toMatch(/利用目的.*書く予定/);expect(result.text).not.toMatch(/使っている専門用語|書き換えて|ください|という相談/);expect(result.finalIssues).toEqual([]);expect(result.qualitySafetyHold).not.toBe(true);
 });
});
