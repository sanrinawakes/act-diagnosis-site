import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';
import { containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference } from '../src/lib/coaching-action-language.mjs';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';
const source = readFileSync(resolve(process.cwd(), 'scripts/evaluate-coaching-quality.mjs'), 'utf8');
const specification = source.slice(source.indexOf('const BASELINE_QUALITY_POPULATION ='), source.indexOf('const args ='));
const evaluation = source.slice(source.indexOf('function evaluateConversations('), source.indexOf('function getLocalTurnExpectation('));
const evaluate = vm.runInNewContext(`${specification}\n${evaluation}\nevaluateConversations`, {
  seededContinuityScenarios, evaluateSeededContinuityResponse, containsDeadlineOutcomeAssurance,
  containsUnsupportedEmotionIntensity, containsUnsupportedConcernPremise, currentTopicUserTexts, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, containsMisfocusedFriendDeclineQuestion, containsUnsupportedRentExplanationReply, containsChainedPreparationInstructions, containsChainedEditingInstructions, containsCircularSingleAction, containsChainedCommunicationInstructions, containsUnsupportedProcedureInterfacePremise, containsUnsupportedSituationPremise, containsUngroundedTaskAssumption, containsAmbiguousFutureActionDayReference,
  getLocalTurnExpectation: () => ({ finishReason: 'STOP' }), countCoachingMoves: () => 0,
  addCheck: (checks: unknown[], name: string, passed: boolean) => checks.push({ name, passed }),
  expectedPipelineMode: 'minimal', expectedTextModel: '', expectedImageModel: '', maxFirstChunkMs: 10000, maxTotalMs: 15000,
});
function turn(user: string, message: string, label: string) {
  return { user, message, rawMessage: message, label, status: 200, hasDone: true, completionStatus: 'complete', finalizationStatus: 'complete',
    finishReason: 'STOP', firstChunkMs: 100, totalMs: 1000, outputChars: message.length, qualityInitialIssues: [], qualityFinalIssues: [] };
}

const fear = '上司に否定されたように感じて、次の一言が怖いです。';
const badBoss = '上司に否定されたように感じ、次に何を言ってもまた否定されるのではないかと、言葉を出す前に止まっているのですね。';
const badHome = '家で今いちばん止まっている出来事を、一つだけ具体的に教えてください。';
const actionUser = '同時接続テスト1です。明日の朝に始める行動を一つだけ、質問なしで答えてください。';
const badTask = '明日の朝一番に、今日残した作業のリストを1つ確認してください。';
const positiveTask = '明日の朝、終わらせたい用事を一つだけ紙に書いてください。';
function passed(user: string, message: string, ending: string, seedHistory: {role:string;content:string}[] = []) {
  return evaluate([{name:'finite-existing-observation',seedHistory,turns:[turn(user,message,'actual')]}]).checks
    .find((check:{name:string}) => check.name.endsWith(ending))?.passed;
}
describe('finite situation and task grounding in standard evaluation', () => {
  it('rejects the observed boss stopped-speech premise', () => {
    expect(passed(fear,badBoss,'本人未申告の停止状況や実指摘を前提にしない')).toBe(false);
  });
  it('rejects the observed home stalled-event premise after a topic switch', () => {
    expect(passed('仕事の整理はできました。今度は家での相談です。',badHome,'本人未申告の停止状況や実指摘を前提にしない')).toBe(false);
  });
  it('rejects the observed assumed leftover-work list', () => {
    expect(passed(actionUser,badTask,'本人未申告の作業や資料内容・原因を前提にしない')).toBe(false);
  });
  it('keeps the existing paper action without assuming an artifact', () => {
    expect(passed(actionUser,positiveTask,'本人未申告の作業や資料内容・原因を前提にしない')).toBe(true);
  });
  it('keeps a leftover-work list actually stated by the user', () => {
    expect(passed(actionUser,badTask,'本人未申告の作業や資料内容・原因を前提にしない',[{role:'user',content:'今日残した作業のリストを作りました。'}])).toBe(true);
  });
  it('does not use an AI statement as evidence of that list', () => {
    expect(passed(actionUser,badTask,'本人未申告の作業や資料内容・原因を前提にしない',[{role:'assistant',content:'今日残した作業のリストがあるのですね。'}])).toBe(false);
  });
});

// Exact 020120 R1 T9 public delivery; no provider-original claim.
const artifactCauseObserved = {
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
      "content": "専門用語を減らして、初めてサービスを使う人に分かりやすく伝えたいのですね。業界用語や内部の名称を、日常で使う言葉へ置き換える作業が役に立ちます。\n\n資料の中で、分かりにくいと感じている言葉はどれですか？"
    },
    {
      "role": "user",
      "content": "説明する順番にも迷っています。"
    },
    {
      "role": "assistant",
      "content": "順番に迷っているなら、資料全体を一度に直すより、一枚ごとの役割を固定した方が早いです。一枚目は「何のためのサービスか」、二枚目は「どう使うか」、三枚目以降で補足という順に並べてください。"
    },
    {
      "role": "user",
      "content": "一枚目には利用目的を書く予定です。"
    },
    {
      "role": "assistant",
      "content": "一枚目には利用目的を書く予定なのですね。"
    },
    {
      "role": "user",
      "content": "二枚目には利用手順を書く予定です。"
    },
    {
      "role": "assistant",
      "content": "企画の説明資料の二枚目には利用手順を書く予定なのですね。初めてサービスを使う人が流れを追えるよう、「最初にすること」「その結果」「次にすること」の三段を整理の枠として使えます。実際の手順の数や動作は、サービスの内容に合わせて考えます。まず二枚目の利用手順を、この並びに沿って書き出してください。"
    },
    {
      "role": "user",
      "content": "担当者から、資料は火曜午前10時までと言われました。"
    },
    {
      "role": "assistant",
      "content": "資料の締切は火曜午前10時なのですね。期限までに仕上げられるかは、資料の進み具合と使える時間を確認する必要があります。載せる内容を決める作業、文章を書く作業、全体を読み返す作業を分けると、あと何が必要かを確認できます。\n\n今の資料で、まだ書き終えていない部分はどこですか？"
    },
    {
      "role": "user",
      "content": "今日は一枚目から直そうと思います。"
    },
    {
      "role": "assistant",
      "content": "今日は一枚目から直す方針で良いです。最初に直すのは、一枚目の利用目的を一文に絞ることです。一枚目の利用目的を、「このサービスで何ができるか」が一文で伝わる形に書き直してください。"
    }
  ],
  "latest": "目的の説明が長くなりすぎています。",
  "candidate": "目的の説明が長くなっているのですね。長くなる原因は、サービスの特徴や細かいメリットを一つの文に詰め込みすぎていることにあります。\n\n一枚目の目的は「誰が・どうなるか」だけを残し、それ以外の補足説明を二枚目以降に回してください。"
} as {history:Array<{role:string;content:string}>;latest:string;candidate:string};
describe('standard evaluator checks the observed unseen artifact cause at every turn', () => {
  it('rejects the actual cause despite clean model flags', () => {
    expect(passed(artifactCauseObserved.latest, artifactCauseObserved.candidate, '本人未申告の作業や資料内容・原因を前提にしない', artifactCauseObserved.history)).toBe(false);
  });
  it('keeps an explicitly conditional possibility without diagnosing the artifact', () => {
    const conditional = 'もしサービスの特徴や細かいメリットを一つの文に詰め込んでいるなら、説明が長くなる可能性があります。';
    expect(passed(artifactCauseObserved.latest, conditional, '本人未申告の作業や資料内容・原因を前提にしない', artifactCauseObserved.history)).toBe(true);
  });
  it('does not use a later user statement to justify the earlier cause', () => {
    const result = evaluate([{ name: 'finite-existing-observation', seedHistory: artifactCauseObserved.history, turns: [
      turn(artifactCauseObserved.latest, artifactCauseObserved.candidate, 'cause-9'),
      turn('サービスの特徴やメリットを一つの文に詰め込んだことが、長くなった原因です。', 'そのように考えているのですね。', 'cause-10'),
    ] }]);
    expect(result.checks.find((check: {name:string}) => check.name === 'cause-9: 本人未申告の作業や資料内容・原因を前提にしない')?.passed).toBe(false);
  });
});
