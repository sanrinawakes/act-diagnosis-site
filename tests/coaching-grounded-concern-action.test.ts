import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { containsUnsupportedConcernPremise, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
import { containsCircularSingleAction, containsUngroundedTaskAssumption } from '../src/lib/coaching-action-language.mjs';
const transport = vi.hoisted(() => ({ raw: '', external: 0, primary: 0, repair: 0, alerts: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => (transport.primary++, { stream: (async function* () { yield { text: () => transport.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }),
  sendMessage: async () => (transport.repair++, { response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }),
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.external++; throw new Error('NETWORK_DISABLED'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alerts++; throw new Error('ALERT_DISABLED'); } }));
import { assessCoachingResponseQuality, ensureVerifiedCoachingResolution, normalizeCoachingOutput, buildGeminiParts, createJsonLineStream, type CoachingChatMessage } from '../src/lib/coaching-gemini';
import { getContextualizedPrompt } from '../src/data/coaching-system-prompt';
// Fixed synthetic standard-suite public deliveries, not original provider text.
export const observedGroundingCases = [
  {
    "name": "seeded-actor-particle-is-not-a-reason-1",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約を受け付けています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを教えてください。"
      },
      {
        "role": "user",
        "content": "お客様から予約をキャンセルしたいと連絡がありました。"
      },
      {
        "role": "assistant",
        "content": "接客のお仕事でしょうか？"
      }
    ],
    "latest": "はい、接客の仕事です。",
    "candidate": "お客様から予約キャンセルの連絡を受けたことについて、どのような対応で迷っていますか？",
    "expectedIssue": "context_mismatch",
    "provenance": "prior2c actual public-delivery regression; currently fixed and must remain fixed"
  },
  {
    "name": "long-continuity-three-turn-reference-3",
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
      }
    ],
    "latest": "専門用語を減らしたいです。",
    "candidate": "専門用語を減らして、初めて使う人にわかりやすく伝えたいのですね。専門用語を日常で使う言葉や具体的な動作に置き換えると、読者が途中でつまずかずに読み進められます。\n\n資料の中で、特にどの言葉の言い換えに迷っていますか？",
    "expectedIssue": "context_mismatch",
    "provenance": "current5e86 actual public delivery, q2 turn3; future turn4 excluded"
  },
  {
    "name": "parallel-burst-4-1",
    "history": [],
    "latest": "同時接続テスト4です。明日の朝に始める行動を一つだけ、質問なしで答えてください。",
    "candidate": "明日の朝、最初に行う作業に一つだけ着手してください。",
    "expectedIssue": "vague_action_target",
    "provenance": "current5e86 actual public delivery, emptyhistory parallel4"
  },
  {
    "name": "actual-q3-explicit-deadline-reference-10",
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
        "content": "初めてサービスを使う人に向けて、専門用語を減らしたいのですね。用語を日常的な言葉へ言い換えることで、読者が直感的に理解しやすくなります。\n\n資料の中で、特に言い換えに迷っている専門用語は何ですか？"
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
        "content": "一枚目を利用目的にする方針で揃っているのですね。初めて使う人向けの資料なら、一枚目は「このサービスで何ができるか」を一文で言い切る役割に固定した方が、後ろの手順ページも組みやすくなります。まず一枚目の見出しと説明を見直し、利用目的が一文で読める形に絞ってください。"
      },
      {
        "role": "user",
        "content": "二枚目には利用手順を書く予定です。"
      },
      {
        "role": "assistant",
        "content": "この企画の説明資料は、一枚目で利用目的を伝え、二枚目で利用手順を見せる並びですね。初めてサービスを使う人向けなら、二枚目は説明を増やすより、「1. 何を押すか」「2. 何が表示されるか」「3. 次に何をするか」の三段で読める形にした方が、専門用語に引っかからず流れを追いやすくなります。まず二枚目の手順を三段だけに絞って書き出してください。"
      },
      {
        "role": "user",
        "content": "担当者から、資料は火曜午前10時までと言われました。"
      },
      {
        "role": "assistant",
        "content": "担当者から、企画の説明資料の提出を火曜午前10時までに指定されたのですね。一枚目の利用目的と二枚目の利用手順の整理が進みつつありますが、まだ実際の作成時間や残りの作業量がどれくらいあるかによって、進め方が変わります。\n\n火曜午前10時の提出までに、資料作成に使える時間はどのくらい確保できそうですか？"
      },
      {
        "role": "user",
        "content": "今日は一枚目から直そうと思います。"
      },
      {
        "role": "assistant",
        "content": "今日は一枚目から直す方針で良いです。最初に直すのは、一枚目の利用目的を一文に絞ることです。「このサービスで何ができるか」を一文だけ残し、説明を足す前に他の文をいったん削ってください。"
      },
      {
        "role": "user",
        "content": "目的の説明が長くなりすぎています。"
      },
      {
        "role": "assistant",
        "content": "目的の説明が長くなっているのですね。一枚目は「誰が」「どうなるか」の二点だけに絞ると、短くまとまりやすくなります。\n\n今の説明から「誰が」「どうなるか」に関係する言葉だけを残し、それ以外の補足文を一つ消してください。"
      }
    ],
    "latest": "3回前に伝えた締切時刻も踏まえて、今日最初に直す箇所を一つだけ、質問なしで答えてください。",
    "candidate": "今日最初に直す箇所は、一枚目にある利用目的の説明文です。",
    "expectedIssue": "requested_time_mismatch",
    "sourceReportSha256": "c64fe3b8986c60d8976bacd8ff8d20229c7b4680b5a4d4b76f4c455ed9236bbe",
    "provenance": "actual public delivery, provider original unavailable; all ten turns read"
  },
  {
    "name": "actual-q3-same-concern-form-3",
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
      }
    ],
    "latest": "専門用語を減らしたいです。",
    "candidate": "初めてサービスを使う人に向けて、専門用語を減らしたいのですね。用語を日常的な言葉へ言い換えることで、読者が直感的に理解しやすくなります。\n\n資料の中で、特に言い換えに迷っている専門用語は何ですか？",
    "expectedIssue": "context_mismatch",
    "provenance": "same actual q3 T3, publicly delivered synthetic standard turn"
  }
] as const;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function streamCandidate(item: typeof observedGroundingCases[number], mode: string) {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
  vi.stubGlobal('fetch', async () => { throw new Error('NETWORK_DISABLED'); });
  transport.raw = item.candidate; const history = item.history.map(message => ({ ...message })) as CoachingChatMessage[];
  const memory: { message: string }[] = [];
  const reader = createJsonLineStream({ systemPrompt: 'Fixed synthetic offline regression.', historyMessages: history,
    lastUserParts: buildGeminiParts(item.latest, [], history), onDone: async (_usage, completion) => { memory.push(completion); return {}; } }).getReader();
  const decoder = new TextDecoder(); let wire = '';
  while (true) { const chunk = await reader.read(); if (chunk.done) break; wire += decoder.decode(chunk.value, { stream: true }); }
  wire += decoder.decode(); const events = wire.trim().split('\n').map(line => JSON.parse(line));
  const done = events.filter(event => event.type === 'done'); expect(done).toHaveLength(1); expect(memory).toHaveLength(1);
  expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done[0].message);
  expect(memory[0].message).toBe(done[0].message); expect(transport.external).toBe(0);
  return done[0];
}
describe('actual concern, circular action and explicit deadline reference', () => {
  for (const item of observedGroundingCases) {
    it('detects '+item.name, () => {
      expect(assessCoachingResponseQuality({ text: item.candidate, lastUserText: item.latest,
        historyMessages: item.history.map(message => ({...message})) as CoachingChatMessage[] }).issues).toContain(item.expectedIssue);
    });
    for (const mode of ['minimal', 'legacy', 'observe']) it('verifies full delivery '+item.name+' in '+mode, async () => {
      const done = await streamCandidate(item, mode);
      expect(done.qualityInitialIssues).toContain(item.expectedIssue);
      if (mode === 'observe') { expect(done.message).toBe(item.candidate); return; }
      expect(done.message).not.toBe(item.candidate); expect(done.qualityFinalIssues).toEqual([]); expect(done.qualitySafetyHold).toBe(false);
      if (item.name.includes('concern-form') || item.name === 'long-continuity-three-turn-reference-3') {
        expect(done.message).toMatch(/資料|専門用語/); expect(done.message).toMatch(/言い換えたい/);
        expect(done.message).not.toMatch(/一枚目|迷|困|不安|明日|5分/);
      } else if (item.expectedIssue === 'vague_action_target') {
        expect(done.message).toMatch(/明日の朝/); expect(done.message).toBe('明日の朝、深呼吸を一回だけしてください。');
        expect(done.message).not.toMatch(/[？?]/);
      } else if (item.expectedIssue === 'requested_time_mismatch') {
        expect(done.message).toContain('火曜午前10時'); expect(done.message).toMatch(/一枚目|利用目的/); expect(done.message).not.toMatch(/[？?]/);
      } else {
        expect(done.message).toContain('キャンセル'); expect(done.message).not.toMatch(/迷|困|不安/);
      }
    });
  }
});

const stateControls = [
  { user: '新しい役割を引き受けるか迷っています。', reply: '新しい役割を引き受けるか迷っているのですね。', negative: '今は迷っていません。', question: '役割を引き受けるか迷っていますか？', third: '同僚は対応に迷っています。' },
  { user: '夫との関係で困っています。', reply: '夫との関係で困っているのですね。', negative: '今は困っていません。', question: '関係について困っていることはありますか？', third: '同僚は対応に困っています。' },
  { user: '途中で感情的になりそうで不安です。', reply: '途中で感情が強くなりそうなのが不安なんですね。', negative: '今は不安はありません。', question: '何か不安なことはありますか？', third: '同僚は対応に不安があります。' },
];
describe('current topic and user-owned state evidence', () => {
  it.each(stateControls)('keeps an explicit user state: $user', ({ user, reply }) => {
    expect(containsUnsupportedConcernPremise(reply, [user])).toBe(false);
  });
  it.each(stateControls)('latest negative cancels an older affirmative: $negative', ({user, reply, negative}) => {
    expect(containsUnsupportedConcernPremise(reply, [user, negative])).toBe(true);
  });
  it.each(stateControls)('a third-party subject is not the user: $third', ({ third, reply }) => {
    expect(containsUnsupportedConcernPremise(reply, [third])).toBe(true);
  });
  it('preserves a third-party actor before the nominalized feeling object', () => {
    expect(containsUnsupportedConcernPremise('途中で感情が強くなりそうなのが不安なんですね。',
      ['同僚は途中で感情的になりそうなのが不安です。'])).toBe(true);
    expect(containsUnsupportedConcernPremise('同僚は途中で感情が強くなりそうなのが不安なんですね。',
      ['同僚は途中で感情的になりそうなのが不安です。'])).toBe(false);
  });
  it.each(stateControls)('quoted third-party state is not the user: $user', ({user, reply}) => {
    expect(containsUnsupportedConcernPremise(reply, [`同僚は「${user}」と言いました。`])).toBe(true);
  });
  it.each(stateControls)('does not carry a prior topic state forward: $user', ({user, reply}) => {
    expect(containsUnsupportedConcernPremise(reply, currentTopicUserTexts([user, '話題を変えて、資料の言葉を言い換えたいです。']))).toBe(true);
  });
  it.each(stateControls)('keeps a genuine existence or yes-no question: $question', ({question}) => {
    expect(containsUnsupportedConcernPremise(question, [])).toBe(false);
  });
  it('keeps a faithful quote, but not an added assertion outside it', () => {
    const user = '同僚は「対応に迷っています」と言いました。';
    const quote = '同僚は「対応に迷っています」と言ったのですね。';
    expect(containsUnsupportedConcernPremise(quote, [user])).toBe(false);
    expect(containsUnsupportedConcernPremise(quote+'あなたも対応に迷っています。', [user])).toBe(true);
  });
  it('keeps a conditional rather than asserting the condition', () => {
    expect(containsUnsupportedConcernPremise('もし対応に迷っているなら、確認したいことを一つ選べます。', [])).toBe(false);
  });
  it('does not use an assistant-only state or a later turn as earlier evidence', () => {
    const item = observedGroundingCases[1];
    const history = [...item.history, { role: 'assistant', content: '言い換えに迷っているのですね。' }] as CoachingChatMessage[];
    expect(assessCoachingResponseQuality({ text: item.candidate, lastUserText: item.latest, historyMessages: history }).issues).toContain('context_mismatch');
  });
});
describe('concrete action and requested target are different contracts', () => {
  it.each([
    '明日の朝、終わらせたい用事を一つだけ紙に書いてください。',
    '明日の朝、同時接続テスト2を開始してください。',
    '今日最初に直す箇所は、一枚目にある利用目的の説明文です。',
  ])('does not call an existing concrete action or target circular: %s', text => {
    expect(containsCircularSingleAction(text)).toBe(false);
  });
  it('keeps the target-only answer free of an action issue while finding its missing deadline', () => {
    const item = observedGroundingCases[3];
    const issues = assessCoachingResponseQuality({text: item.candidate, lastUserText: item.latest, historyMessages: item.history.map(message=>({...message})) as CoachingChatMessage[]}).issues;
    expect(issues).toContain('requested_time_mismatch'); expect(issues).not.toContain('vague_action_target');
  });
  it.each(['火曜日午前10時', '火曜午前１０時', '火曜午前10時0分'])('accepts an equivalent requested deadline: %s', deadline => {
    const item = observedGroundingCases[3];
    const text = `${deadline}の締切に向けて、今日最初に直す箇所は、一枚目にある利用目的の説明文です。`;
    expect(assessCoachingResponseQuality({text, lastUserText:item.latest, historyMessages:item.history.map(message=>({...message})) as CoachingChatMessage[]}).issues).not.toContain('requested_time_mismatch');
  });
  it.each([
    { latest: '締切は金曜午後3時に変更されました。', deadline: '金曜午後3時' },
    { latest: '締切は未定です。', deadline: '' },
    { latest: '話題を変えて、別の資料を直しています。', deadline: '' },
  ])('only requires the current user-provided time after: $latest', ({latest, deadline}) => {
    const item = observedGroundingCases[3];
    const history: CoachingChatMessage[] = [...item.history.map(message=>({...message})), {role:'user', content:latest}];
    const text = `${deadline ? deadline+'の締切に向けて、' : ''}今日最初に直す箇所は、一枚目にある利用目的の説明文です。`;
    expect(assessCoachingResponseQuality({text,lastUserText:item.latest,historyMessages:history}).issues).not.toContain('requested_time_mismatch');
  });
});


// No live cases or model calls are added.
// trace22126-80 is captured PUBLIC delivery; provider-original text was not saved.
const openingWriteObserved = {
  latest: '同時接続テスト3です。明日の朝に始める行動を一つだけ、質問なしで答えてください。',
  candidate: '明日の朝起きたら、ノートを一冊開き、今日一番優先したい作業の名前を一つだけ書き出してください。',
  history: [] as CoachingChatMessage[],
};
const openingWriteSeen: unknown[] = [];
afterAll(() => {
  const output = process.env.ACTI_OPEN_WRITE_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({
    scope: 'Exact synthetic public delivery plus bounded opening/write grammar controls',
    providerOriginalRaw: 'NOT_CAPTURED', newLiveCases: 0, actuals: openingWriteSeen,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});
function assessOpeningWrite(text: string, latest = openingWriteObserved.latest) {
  return assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: [] });
}
function verifyOpeningWrite(text: string) {
  const quality = assessOpeningWrite(text);
  return ensureVerifiedCoachingResolution({
    resolution: { text, usage: {}, modelName: 'local-public-fixture', provider: 'local',
      repairAttempted: false, repairAccepted: false,
      initialIssues: quality.issues, finalIssues: quality.issues },
    lastUserText: openingWriteObserved.latest, historyMessages: [],
  });
}
function expectOneSelfContainedMorningAction(text: string) {
  expect(text).not.toBe(openingWriteObserved.candidate);
  expect(text).toContain('明日の朝');
  expect(text).toMatch(/(?:一|1)回だけ/);
  expect(text).toBe('明日の朝、深呼吸を一回だけしてください。');
  expect(text).not.toMatch(/開き|開い|今日|本日|[？?]|(?:リスト|メモ)を確認|もう一度送って|という相談ですね/);
  expect(assessOpeningWrite(text).issues).toEqual([]);
}
async function streamOpeningWrite(mode: string) {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
  let forbiddenFetchAttempts = 0;
  vi.stubGlobal('fetch', async () => { forbiddenFetchAttempts++; throw Error('NETWORK_DISABLED'); });
  transport.raw = openingWriteObserved.candidate;
  const callbacks: Array<{message: string}> = [];
  const reader = createJsonLineStream({
    systemPrompt: getContextualizedPrompt('MGA-3'), historyMessages: [],
    lastUserParts: buildGeminiParts(openingWriteObserved.latest, [], []),
    onDone: async (_usage, completion) => { callbacks.push(completion); return {}; },
  }).getReader();
  const decoder = new TextDecoder(); let wire = '';
  while (true) { const chunk = await reader.read(); if (chunk.done) break; wire += decoder.decode(chunk.value, {stream: true}); }
  wire += decoder.decode();
  const events = wire.trim().split('\n').map(line => JSON.parse(line));
  const dones = events.filter(event => event.type === 'done'); const done = dones[0];
  // Save the actual wire and callback before any assertion, including failures.
  openingWriteSeen.push({stage: 'mock-fullstream', mode, ...openingWriteObserved,
    injectedCandidateKind: 'captured-public-final-not-original-provider',
    wire, events, callbacks, done, final: done?.message, forbiddenFetchAttempts,
    externalProviderAttempts: transport.external});
  expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
  expect(done.completionStatus).toBe('complete'); expect(done.finalizationStatus).toBe('complete');
  expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
  expect(callbacks[0].message).toBe(done.message);
  expect(forbiddenFetchAttempts).toBe(0); expect(transport.external).toBe(0);
  return done;
}
describe('observed one-action request rejects notebook opening plus writing', () => {
  it.each(['minimal', 'legacy', 'observe'])('detects the exact public candidate in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const quality = assessOpeningWrite(openingWriteObserved.candidate);
    openingWriteSeen.push({stage: 'assess', mode, ...openingWriteObserved, quality});
    expect(quality.issues).toContain('multiple_coaching_moves');
  });
  it.each(['minimal', 'legacy', 'observe'])('retains direct and normalized verification evidence in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const normalized = normalizeCoachingOutput(openingWriteObserved.candidate, openingWriteObserved.latest, []);
    const direct = verifyOpeningWrite(openingWriteObserved.candidate);
    const normalizedVerified = verifyOpeningWrite(normalized);
    openingWriteSeen.push({stage: 'verified-two-paths', mode, ...openingWriteObserved,
      normalized, normalizedQuality: assessOpeningWrite(normalized), direct, normalizedVerified});
    if (mode === 'observe') {
      expect(direct.text).toBe(openingWriteObserved.candidate);
      expect(direct.initialIssues).toContain('multiple_coaching_moves');
      return; // This is known-bad detection-only, not semantic delivery PASS.
    }
    expectOneSelfContainedMorningAction(direct.text);
    expectOneSelfContainedMorningAction(normalizedVerified.text);
    expect(direct.qualitySafetyHold).not.toBe(true);
    expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
  });
  it.each(['minimal', 'legacy', 'observe'])('records full mock delivery in %s', async mode => {
    const done = await streamOpeningWrite(mode);
    expect(done.qualityInitialIssues).toContain('multiple_coaching_moves');
    if (mode === 'observe') { expect(done.message).toBe(openingWriteObserved.candidate); return; }
    expectOneSelfContainedMorningAction(done.message);
    expect(done.qualityFinalIssues).toEqual([]); expect(done.qualitySafetyHold).not.toBe(true);
  });
});
describe('bounded opening/write connective and quotation contracts', () => {
  it.each([
    '明日の朝、ノートを開き、用事を一つだけ書いてください。',
    '「ノートを開き、用事を一つだけ書いてください。」',
    '「ノートを開き、用事を一つだけ書いてください」を試してみてください。',
  ])('detects two instructed operations without relying on the ambiguous day: %s', text => {
    const quality = assessOpeningWrite(text);
    openingWriteSeen.push({stage: 'opening-grammar-reject', text, latest: openingWriteObserved.latest, quality});
    expect(quality.issues).toContain('multiple_coaching_moves');
  });
  it.each([
    {name: 'single-write', text: '明日の朝、終わらせたい用事を一つだけ紙に書いてください。', latest: openingWriteObserved.latest},
    {name: 'single-open', text: '明日の朝、ノートを一冊だけ開いてください。', latest: openingWriteObserved.latest},
    {name: 'past-report', text: 'ノートを開き、一文を書いたのですね。', latest: 'ノートを開き、一文を書きました。'},
    {name: 'faithful-quoted-report', text: '「ノートを開き、一文を書いてください」とAIに言われたのですね。', latest: '「ノートを開き、一文を書いてください」とAIに言われました。'},
    {name: 'one-conveyed-utterance', text: '「ノートを開き、一文を書いてください」とだけ伝えてください。', latest: '相手に伝える一言を一つだけ教えてください。'},
    {name: 'opening-method-noun', text: 'ノートの開き方を確認してください。', latest: openingWriteObserved.latest},
    {name: 'no-opening-and-writing-required', text: 'ノートを開き、一文を書く必要はありません。', latest: openingWriteObserved.latest},
    {name: 'explicit-multiple-request', text: 'ノートを開き、用事を一つだけ書いてください。', latest: 'ノートを開いて一文を書く手順を、二つの操作に分けて説明してください。'},
  ])('does not turn $name into two newly instructed operations', item => {
    const quality = assessOpeningWrite(item.text, item.latest);
    openingWriteSeen.push({stage: 'opening-grammar-preserve', ...item, quality});
    expect(quality.issues).not.toContain('multiple_coaching_moves');
    if (item.name === 'single-write') expect(quality.issues).toEqual([]);
  });
});

// Prepared bounded regression for the saved a871 short-reply turn 2.
// The injected fixture is public delivery, not an original provider candidate.
const declineFocusObserved = {
  "name": "short-reply-continuation-2",
  "diagnosisCode": "MME-3",
  "history": [
    {
      "role": "user",
      "content": "友人に断りたい予定があるのに、返事を先延ばしにしています。"
    },
    {
      "role": "assistant",
      "content": "友人との予定を断りたいのに、返事を先延ばしにしているのですね。断りたいという意思はすでに書かれているので、断るべきかどうかをもう一度考える必要はありません。どの時点で返事を止めてしまうかが分かれば、次に考えることを絞れます。返事を書こうとした時、何が気になって送れなくなりますか？"
    }
  ],
  "latest": "断ると関係が悪くなる気がします。",
  "candidate": "断ると関係が悪くなる気がして、返事を送れなくなっているのですね。\n\n相手の反応が気になるときは、断ること自体よりも「どう伝えるか」を考える段階に来ています。\n\nその相手に、まずどの行動を変えてほしいですか？",
  "candidateOrigin": "saved production public delivery; original provider raw NOT_CAPTURED"
} as const;
const declineFocusActuals: unknown[] = [];
afterAll(() => {
  const output = process.env.ACTI_DECLINE_FOCUS_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({
    scope: 'One saved actual plus five finite local controls; no live population change',
    providerOriginalRaw: 'NOT_CAPTURED', actuals: declineFocusActuals,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});
function declineHistory(): CoachingChatMessage[] {
  return declineFocusObserved.history.map(message => ({ ...message }));
}
function assessDeclineFocus(text: string, latest: string = declineFocusObserved.latest, historyMessages = declineHistory()) {
  return assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages });
}
function verifyDeclineFocus(text: string) {
  const quality = assessDeclineFocus(text);
  return ensureVerifiedCoachingResolution({
    resolution: { text, usage: {}, modelName: 'fixed-local-public-fixture', provider: 'local',
      repairAttempted: false, repairAccepted: false, initialIssues: quality.issues, finalIssues: quality.issues },
    lastUserText: declineFocusObserved.latest, historyMessages: declineHistory(),
  });
}
function expectOwnDeclineFocus(text: string) {
  expect(text).toMatch(/断(?:る|っ)|返事/);
  expect(text).toMatch(/反応|返事|伝え/);
  expect(text).not.toMatch(/相手に[、,]?まずどの行動を変えて|相手に変えてほしい行動|考える段階に来ています|以前その友人の誘いを断った時|今回も関係が悪|という相談ですね/);
  expect((text.match(/[？?]/g) || [])).toHaveLength(1);
  expect(assessDeclineFocus(text).issues).toEqual([]);
}
describe('saved own refusal reply keeps the user goal', () => {
  it.each(['minimal', 'legacy', 'observe'])('detects the saved public mismatch and records both verified paths in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const quality = assessDeclineFocus(declineFocusObserved.candidate);
    const normalized = normalizeCoachingOutput(declineFocusObserved.candidate, declineFocusObserved.latest, declineHistory());
    const normalizedQuality = assessDeclineFocus(normalized);
    const direct = verifyDeclineFocus(declineFocusObserved.candidate);
    const normalizedVerified = verifyDeclineFocus(normalized);
    const unflagged = ensureVerifiedCoachingResolution({resolution:{text:declineFocusObserved.candidate,usage:{},modelName:'same-decline-empty-flags-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:[],finalIssues:[]},lastUserText:declineFocusObserved.latest,historyMessages:declineHistory()});
    declineFocusActuals.push({ stage: 'two-public-paths', mode, ...declineFocusObserved,
      quality, normalized, normalizedQuality, direct, normalizedVerified, unflagged });
    expect(quality.issues).toContain('context_mismatch');
    if (mode === 'observe') {
      expect(direct.text).toBe(declineFocusObserved.candidate);
      expect(direct.initialIssues).toContain('context_mismatch');
      expect(unflagged.text).toBe(declineFocusObserved.candidate);expect(unflagged.initialIssues).toContain('context_mismatch');
      // Pure normalization is recorded separately. An unchanged bad intermediate
      // must remain detected, and is never labelled semantic delivery success.
      if (normalized === declineFocusObserved.candidate) {
        expect(normalizedQuality.issues).toContain('context_mismatch');
        expect(normalizedVerified.initialIssues).toContain('context_mismatch');
      } else {
        expectOwnDeclineFocus(normalizedVerified.text);
        expect(normalizedVerified.finalIssues).toEqual([]);
      }
      return;
    }
    expectOwnDeclineFocus(unflagged.text);expect(unflagged.initialIssues).toContain('context_mismatch');expect(unflagged.qualitySafetyHold).not.toBe(true);
    expectOwnDeclineFocus(direct.text); expectOwnDeclineFocus(normalizedVerified.text);
    expect(direct.finalIssues).toEqual([]); expect(normalizedVerified.finalIssues).toEqual([]);
    expect(direct.qualitySafetyHold).not.toBe(true); expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
  });
  it.each(['minimal', 'legacy', 'observe'])('records final delivery and callback in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    let forbiddenFetchAttempts = 0;
    vi.stubGlobal('fetch', async () => { forbiddenFetchAttempts++; throw Error('NETWORK_DISABLED'); });
    transport.raw = declineFocusObserved.candidate;
    const before = { primary: transport.primary, repair: transport.repair, external: transport.external, alerts: transport.alerts };
    const callbacks: Array<{ message: string }> = [];
    const reader = createJsonLineStream({
      systemPrompt: getContextualizedPrompt(declineFocusObserved.diagnosisCode), historyMessages: declineHistory(),
      lastUserParts: buildGeminiParts(declineFocusObserved.latest, [], declineHistory()),
      onDone: async (_usage, completion) => { callbacks.push(completion); return {}; },
    }).getReader();
    const decoder = new TextDecoder(); let wire = '';
    while (true) { const next = await reader.read(); if (next.done) break; wire += decoder.decode(next.value, { stream: true }); }
    wire += decoder.decode(); const events = wire.trim().split('\n').map(line => JSON.parse(line));
    const dones = events.filter(event => event.type === 'done'); const done = dones[0];
    const mockCallDelta = { primary: transport.primary - before.primary, repair: transport.repair - before.repair,
      external: transport.external - before.external, alerts: transport.alerts - before.alerts };
    declineFocusActuals.push({ stage: 'mock-fullstream', mode, ...declineFocusObserved,
      mockCallDelta, configuredCandidateConsumed: mockCallDelta.primary > 0,
      forbiddenFetchAttempts, wire, events, callbacks, final: done?.message });
    expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
    expect(done.completionStatus).toBe('complete'); expect(done.finalizationStatus).toBe('complete');
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
    expect(callbacks[0].message).toBe(done.message);
    expect(forbiddenFetchAttempts).toBe(0); expect(mockCallDelta.external).toBe(0); expect(mockCallDelta.alerts).toBe(0);
    if (mockCallDelta.primary > 0) expect(done.qualityInitialIssues).toContain('context_mismatch');
    if (mode === 'observe' && mockCallDelta.primary > 0) {
      expect(done.message).toBe(declineFocusObserved.candidate);
      return; // Known-bad observed delivery is detection-only.
    }
    expectOwnDeclineFocus(done.message); expect(done.qualityFinalIssues).toEqual([]);
    expect(done.qualitySafetyHold).not.toBe(true);
  });
});
const declineFocusControls = [
  {
    name: 'existing-planning-own-refusal-question', latest: declineFocusObserved.latest, history: declineHistory(),
    text: '断った後に友人との関係が悪くなる気がして、返事をためらっているのですね。これから起きるかもしれないことと、実際に起きたことは分けて考えられます。今の段階では、断った時の反応をこちらで決めつけることはできません。\n\n断ると、友人からどんな反応があると考えていますか？',
    basis: 'Existing planning fallback at current source 4812, actual current context',
  },
  {
    name: 'explicit-current-user-other-action-goal', history: declineHistory(),
    latest: '今回は断り返事ではなく、友人に変えてほしい行動を考えたいです。',
    text: '友人に変えてほしい行動を考えたいのですね。\n\nその相手に、まずどの行動を変えてほしいですか？',
    basis: 'Bounded explicit current USER other-change goal; asks which behavior before it is supplied, not a repeated known answer',
  },
  {
    name: 'faithful-question-report-is-not-new-other-action-question', history: declineHistory(),
    latest: 'AIから「その相手に、まずどの行動を変えてほしいですか？」と聞かれました。私は友人への断り返事の話をしています。',
    text: 'AIから「その相手に、まずどの行動を変えてほしいですか？」と聞かれたのですね。\n\n友人への断り返事について、今どの点を話したいですか？',
    basis: 'Bounded quoted/report control requested by root; output quote is grounded in this USER report',
  },
  {
    name: 'explicit-topic-switch-keeps-real-household-request', history: declineHistory(),
    latest: '話題を変えて家事の相談です。夫に家事を頼んでも後回しにされます。私ばかり負担している気がして腹が立ちます。',
    text: '家事を頼んでも後回しにされ、自分ばかり負担しているように感じて腹が立つんですね。頼んだ家事を結局自分が引き受ける状態なら、一回の家事ではなく、分担が機能していないことが問題です。\n\n夫に、最初に担当を固定してほしい家事はどれですか？',
    basis: 'Existing household normal contract plus explicit topic boundary; no old refusal goal carryover',
  },
  {
    name: 'explicit-own-reply-wording-stays-a-reply', history: declineHistory(),
    latest: '断ると関係が悪くなる気がします。返事の文面を一つ、質問なしで作ってください。',
    text: '「誘ってくれてありがとう。今回は参加しないことにしました。」',
    basis: 'Existing direct-wording positive contract; does not add an excuse or ask a question',
  },
];
describe('bounded refusal-focus preservation controls', () => {
  it.each(declineFocusControls)('preserves $name', item => {
    const quality = assessDeclineFocus(item.text, item.latest, item.history);
    declineFocusActuals.push({ stage: 'bounded-control', ...item, quality });
    // This assertion protects only the new focus predicate. It does not waive
    // other quality issues or label every control a complete response PASS.
    expect(quality.issues).not.toContain('context_mismatch');
  });
});


// Same two saved public deliveries. No original provider bytes were retained.
const genericMorningObserved = [
  { name: 'a871-r2-parallel-burst-5-1', latest: '同時接続テスト5です。明日の朝に始める行動を一つだけ、質問なしで答えてください。', candidate: '明日の朝、今ある作業の最初の項目をノートに一言だけ書き出してください。' },
  { name: 'a871-r3-parallel-burst-5-1', latest: '同時接続テスト5です。明日の朝に始める行動を一つだけ、質問なしで答えてください。', candidate: '明日の朝、朝起きたら、今日一番優先して進めたい作業をノートに一つ書いてください。' },
] as const;
const genericMorningSeen: unknown[] = [];
afterAll(() => {
  const output = process.env.ACTI_GENERIC_MORNING_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ scope: 'Existing R2/R3 actual deliveries and finite local controls', providerOriginal: 'NOT_CAPTURED', newLiveCases: 0, actuals: genericMorningSeen }, null, 2)+'\n', {flag:'wx',mode:0o600});
});
function genericMorningQuality(text: string, latest: string, history: CoachingChatMessage[] = []) {
  return assessCoachingResponseQuality({text,lastUserText:latest,historyMessages:history});
}
function genericMorningVerify(text: string, latest: string) {
  const q=genericMorningQuality(text,latest);
  return ensureVerifiedCoachingResolution({resolution:{text,usage:{},modelName:'local-public-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:q.issues,finalIssues:q.issues},lastUserText:latest,historyMessages:[]});
}
function expectGroundedGenericMorning(text: string, latest: string) {
  expect(text).toContain('明日の朝');
  expect(text).not.toMatch(/今ある作業|最初の項目|一番優先|今日|本日|ノート|作業|タスク|仕事|用事|[？?]/);
  expect(text).toMatch(/(?:一回|一度|一つ|ひとつ|1つ)(?:だけ)?/);
  expect(text).toMatch(/(?:て|で)ください[。！!]?$/);
  expect(genericMorningQuality(text,latest).issues).toEqual([]);
}
describe('actual generic morning actions do not invent existing task targets',()=>{
  for(const item of genericMorningObserved) for(const mode of ['minimal','legacy','observe']) {
    it(item.name+' direct and normalized '+mode,()=>{
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);
      const initial=genericMorningQuality(item.candidate,item.latest);
      const normalized=normalizeCoachingOutput(item.candidate,item.latest,[]);
      const direct=genericMorningVerify(item.candidate,item.latest);
      const normalizedVerified=genericMorningVerify(normalized,item.latest);
      const unflagged=ensureVerifiedCoachingResolution({resolution:{text:item.candidate,usage:{},modelName:'same-generic-empty-flags-fixture',provider:'local',repairAttempted:false,repairAccepted:false,initialIssues:[],finalIssues:[]},lastUserText:item.latest,historyMessages:[]});
      genericMorningSeen.push({stage:'two-paths',mode,...item,history:[],initial,normalized,normalizedQuality:genericMorningQuality(normalized,item.latest),direct,normalizedVerified,unflagged});
      expect(initial.issues).toContain('ungrounded_task_assumption');
      if(mode==='observe') { expect(direct.text).toBe(item.candidate);expect(direct.initialIssues).toContain('ungrounded_task_assumption');expect(unflagged.text).toBe(item.candidate);expect(unflagged.initialIssues).toContain('ungrounded_task_assumption');return; }
      expectGroundedGenericMorning(direct.text,item.latest);expectGroundedGenericMorning(normalizedVerified.text,item.latest);expectGroundedGenericMorning(unflagged.text,item.latest);expect(unflagged.initialIssues).toContain('ungrounded_task_assumption');expect(unflagged.qualitySafetyHold).not.toBe(true);
      expect(direct.qualitySafetyHold).not.toBe(true);expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
    });
    it(item.name+' full mock delivery '+mode,async()=>{
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE',mode);let forbiddenFetchAttempts=0;
      vi.stubGlobal('fetch',async()=>{forbiddenFetchAttempts++;throw Error('NETWORK_DISABLED');});
      transport.raw=item.candidate;transport.external=0;const callbacks: Array<{message:string}>=[];
      const reader=createJsonLineStream({systemPrompt:getContextualizedPrompt('MGA-3'),historyMessages:[],lastUserParts:buildGeminiParts(item.latest,[],[]),onDone:async(_usage,completion)=>{callbacks.push(completion);return {};}}).getReader();
      const decoder=new TextDecoder();let wire='';while(true){const chunk=await reader.read();if(chunk.done)break;wire+=decoder.decode(chunk.value,{stream:true});}wire+=decoder.decode();
      const events=wire.trim().split('\n').map(line=>JSON.parse(line));const doneEvents=events.filter(e=>e.type==='done');const done=doneEvents[0];
      genericMorningSeen.push({stage:'mock-fullstream',mode,...item,history:[],wire,events,callbacks,done,forbiddenFetchAttempts,externalProviderAttempts:transport.external});
      expect(doneEvents).toHaveLength(1);expect(callbacks).toHaveLength(1);expect(done.completionStatus).toBe('complete');expect(done.finalizationStatus).toBe('complete');
      expect(events.filter(e=>e.type==='chunk').map(e=>e.text).join('')).toBe(done.message);expect(callbacks[0].message).toBe(done.message);expect(forbiddenFetchAttempts).toBe(0);expect(transport.external).toBe(0);
      expect(done.qualityInitialIssues).toContain('ungrounded_task_assumption');
      if(mode==='observe'){expect(done.message).toBe(item.candidate);expect(done.qualityInitialIssues).toContain('ungrounded_task_assumption');return;}
      expectGroundedGenericMorning(done.message,item.latest);expect(done.qualityFinalIssues).toEqual([]);expect(done.qualitySafetyHold).not.toBe(true);
    });
  }
});
const genericMorningEvidenceControls=[
 {name:'own-created-list',texts:['作業リストを作りました。'],expected:false},
 {name:'work-alone-not-item-list',texts:['仕事をしています。'],expected:true},
 {name:'assistant-like-report-not-own-list',texts:['「作業リストを作りました」とAIに言われました。'],expected:true},
 {name:'third-party-list',texts:['夫は作業リストを作りました。'],expected:true},
 {name:'list-revoked',texts:['作業リストを作りました。','そのリストはもうありません。'],expected:true},
 {name:'list-unknown',texts:['作業リストがあるか分かりません。'],expected:true},
 {name:'list-only-new-topic',texts:currentTopicUserTexts(['作業リストを作りました。','話題を変えて、明日の朝に始める行動を一つだけ教えてください。']),expected:true},
];
describe('bounded existing list and topic controls',()=>{
 it.each(genericMorningEvidenceControls)('$name',c=>{
   const actual=containsUngroundedTaskAssumption(genericMorningObserved[0].candidate,c.texts);
   genericMorningSeen.push({stage:'list-control',...c,actual,candidate:genericMorningObserved[0].candidate});expect(actual).toBe(c.expected);
 });
 it('keeps a faithful quote but rejects a new quoted directive',()=>{
   const candidate=genericMorningObserved[0].candidate;
   const user=`「${candidate}」とAIに言われました。`;
   const report=`「${candidate}」とAIに言われたのですね。`;
   const actual={report:containsUngroundedTaskAssumption(report,[user]),directive:containsUngroundedTaskAssumption(`「${candidate}」`,[])};
   genericMorningSeen.push({stage:'quote-controls',candidate,user,report,actual});expect(actual.report).toBe(false);expect(actual.directive).toBe(true);
 });
 it('preserves an already appropriate one-action provider proposal',()=>{
   const candidate='明日の朝は、まずコップ一杯の水をゆっくり飲んでみましょう。';
   const actual=normalizeCoachingOutput(candidate,genericMorningObserved[0].latest,[]);
   genericMorningSeen.push({stage:'valid-one-action',candidate,latest:genericMorningObserved[0].latest,actual});expect(actual).toBe(candidate);
 });
 it.each([
   {name:'current-work',content:'仕事で予約を受け付けています。',domain:/仕事/},
   {name:'current-friend',content:'友人に断る返事をしたいです。',domain:/伝|一文|友人/},
   {name:'current-document',content:'新しい企画の説明資料を作っています。',domain:/資料|見出し/},
 ])('does not replace $name with breathing',c=>{
   const history:CoachingChatMessage[]=[{role:'user',content:c.content}];
   const actual=normalizeCoachingOutput(genericMorningObserved[0].candidate,genericMorningObserved[0].latest,history);
   genericMorningSeen.push({stage:'specific-domain-control',...c,domain:String(c.domain),history,latest:genericMorningObserved[0].latest,candidate:genericMorningObserved[0].candidate,actual,quality:genericMorningQuality(actual,genericMorningObserved[0].latest,history)});
   expect(actual).not.toMatch(/呼吸/);expect(actual).toMatch(c.domain);
 });
});
