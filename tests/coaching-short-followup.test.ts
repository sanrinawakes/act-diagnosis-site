import { afterEach, describe, expect, it, vi } from 'vitest';
import { seededContinuityScenarios, evaluateSeededContinuityResponse } from '../scripts/lib/coaching-continuity-scenarios.mjs';
const transport = vi.hoisted(() => ({ raw: '', repairs: 0, external: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => ({ stream: (async function* () { const text = transport.raw; yield { text: () => text.slice(0, 8) }; yield { text: () => text.slice(8) }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }) }),
  sendMessage: async () => { transport.repairs += 1; return { response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 1 } } }; },
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.external += 1; throw new Error('NETWORK_DISABLED'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { throw new Error('ALERT_DISABLED'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, buildGeminiParts, createJsonLineStream, ensureVerifiedCoachingResolution, normalizeCoachingOutput, type CoachingChatMessage } from '../src/lib/coaching-gemini';
// Captured provider candidates from LOCAL synthetic resampling only. No customer data.
export const capturedSyntheticCases = [
  {
    "name": "apology-after-third-party-cancellation",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約の受付を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近は、どんなやり取りがありましたか？"
      },
      {
        "role": "user",
        "content": "相手から契約を解約したいという申し出がありました。"
      },
      {
        "role": "assistant",
        "content": "仕事で最後に困った場面について、誰が何を言ったか教えてください。"
      }
    ],
    "latest": "すみません。",
    "raw": "謝る必要はありませんよ。解約の申し出を受けたことで、どのような点に困っていますか？"
  },
  {
    "name": "short-customer-service-affirmation",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約の受付を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近は、どんなやり取りがありましたか？"
      },
      {
        "role": "user",
        "content": "相手から契約を解約したいという申し出がありました。"
      },
      {
        "role": "assistant",
        "content": "接客のお仕事でしょうか？"
      }
    ],
    "latest": "はい、接客の仕事です。",
    "raw": "解約の申し出への対応ですね。\n\n相手から解約したい理由について何か説明はありましたか？"
  },
  {
    "name": "draft-after-completed-work",
    "history": [
      {
        "role": "user",
        "content": "仕事の予定が変わり、落ち着いて対応する方法を考えたいです。"
      },
      {
        "role": "assistant",
        "content": "直近の作業ややり取りを一つずつ整理できます。"
      },
      {
        "role": "user",
        "content": "今日の準備は終わりました。"
      },
      {
        "role": "assistant",
        "content": "その後、何かやり取りはありましたか？"
      },
      {
        "role": "user",
        "content": "解約したいと相手から言われました。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "latest": "次回もどうぞよろしくお願いします。",
    "raw": "解約の申し出に対してその言葉を伝えることで、相手に何を一番伝えたいですか？"
  },
  {
    "name": "already-provided-cancellation-reason",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを一つ教えてください。"
      },
      {
        "role": "user",
        "content": "引っ越しが決まったので予約をキャンセルしたいと連絡を受けました。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "latest": "ご希望を伺いました。",
    "raw": "「ご希望を伺いました」とまず受け止める言葉ですね。\n\nその言葉に続けて、キャンセル手続きをそのまま進める案内を入れますか？"
  },
  {
    "name": "explicit-topic-switch-after-opening-question",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約の受付を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近は、どんなやり取りがありましたか？"
      },
      {
        "role": "user",
        "content": "相手から契約を解約したいという申し出がありました。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "latest": "話題を変えて、SNSの投稿について相談したいです。",
    "raw": "SNSの投稿についての相談ですね。\n\nその投稿について、どのような点で迷っていますか？"
  },
  {
    "name": "actor-particle-is-not-a-reason",
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
    "raw": "そのキャンセル連絡について、今どのような対応で迷っていますか？"
  },
  {
    "name": "separately-supplied-reason",
    "history": [
      {
        "role": "user",
        "content": "仕事で予約を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを教えてください。"
      },
      {
        "role": "user",
        "content": "お客様からキャンセルの希望がありました。"
      },
      {
        "role": "assistant",
        "content": "理由について何か聞いていますか？"
      },
      {
        "role": "user",
        "content": "引っ越しが決まったそうです。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "latest": "ご希望を受け取りました。",
    "raw": "「ご希望を受け取りました」と、まずは承ったことを伝える形ですね。\n\nその言葉のあとに続ける案内や手続きは、すでに決まっていますか？"
  }
] as const;
const repairedNames = new Set(['short-customer-service-affirmation', 'actor-particle-is-not-a-reason', 'explicit-topic-switch-after-opening-question']);
afterEach(() => vi.unstubAllEnvs());
async function streamCandidate(scenario: { raw: string; latest: string; history: readonly { role: string; content: string }[] }) {
  transport.raw = scenario.raw; transport.repairs = 0; transport.external = 0;
  const history = scenario.history.map((message) => ({ ...message })) as CoachingChatMessage[];
  const finalized = { message: '' };
  const stream = createJsonLineStream({ systemPrompt: 'synthetic local test', historyMessages: history,
    lastUserParts: buildGeminiParts(scenario.latest, [], history), onDone: async (_usage, completion) => { finalized.message = completion.message; return {}; } });
  const reader = stream.getReader(); const decoder = new TextDecoder(); let text = '';
  while (true) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  const done = events.filter((event) => event.type === 'done');
  expect(done).toHaveLength(1); expect(done[0].completionStatus).toBe('complete'); expect(done[0].finalizationStatus).toBe('complete');
  expect(events.filter((event) => event.type === 'chunk').map((event) => event.text).join('')).toBe(done[0].message);
  expect(finalized.message).toBe(done[0].message); expect(transport.external).toBe(0);
  return done[0];
}
describe('captured short contextual followups through full streaming pipeline', () => {
  for (const mode of ['minimal', 'legacy', 'observe']) {
    it.each(capturedSyntheticCases.filter((scenario) => repairedNames.has(scenario.name)))('verifies the captured short candidate in '+mode+': $name', async (scenario) => {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
      const done = await streamCandidate(scenario);
      if (scenario.name === 'actor-particle-is-not-a-reason') {
        expect(done.qualityInitialIssues).toContain('context_mismatch');
        if (mode === 'observe') {
          expect(done.message).toBe(scenario.raw);
          // Observe records the issue in initial metadata and keeps the text.
          expect(done.qualityFinalIssues).toEqual([]);
        } else {
          expect(done.message).not.toContain('迷っていますか');
          expect(done.message).toContain('キャンセル');
          expect(done.qualityFinalIssues).toEqual([]);
        }
        return;
      }
      expect(done.message).toBe(scenario.raw);
      expect(done.qualityInitialIssues).toEqual([]); expect(done.qualityFinalIssues).toEqual([]);
      expect(done.qualitySafetyHold).toBe(false); expect(transport.repairs).toBe(0);
    });
  }
});

const customerCase = capturedSyntheticCases.find((scenario) => scenario.name === 'actor-particle-is-not-a-reason')!;
const topicCase = capturedSyntheticCases.find((scenario) => scenario.name === 'explicit-topic-switch-after-opening-question')!;
const customerHistory = customerCase.history.map((message) => ({ ...message })) as CoachingChatMessage[];
const neutralCustomerQuestion = 'そのキャンセル連絡について、どのような対応が必要になっていますか？';

// Observed public delivery from the fixed synthetic production scenario. This
// is not a captured pre-normalization provider candidate.
const observedUnstatedServiceConcern = 'お客様から予約キャンセルの連絡を受けたことについて、どのような対応で迷っていますか？';
describe('observed profession answer without a reported concern', () => {
  it('detects the unprovided hesitation premise independently of short length', () => {
    expect(assessCoachingResponseQuality({ text: observedUnstatedServiceConcern,
      lastUserText: customerCase.latest, historyMessages: customerHistory }).issues).toContain('context_mismatch');
  });
  it.each(['minimal', 'legacy', 'observe'])('records or repairs the unprovided concern through full delivery in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const done = await streamCandidate({ raw: observedUnstatedServiceConcern, latest: customerCase.latest, history: customerHistory });
    expect(done.qualityInitialIssues).toContain('context_mismatch');
    if (mode === 'observe') {
      expect(done.message).toBe(observedUnstatedServiceConcern);
      expect(done.qualityFinalIssues).toEqual([]);
    } else {
      expect(done.message).toContain('キャンセル');
      expect(done.message).not.toMatch(/迷って|明日|まだ書かれていない原因|仕事全体/);
      expect(done.qualityFinalIssues).toEqual([]);
      expect(done.qualitySafetyHold).toBe(false);
    }
  });
  it('fails the same fixed standard semantic scenario despite clean numeric metadata', () => {
    expect(evaluateSeededContinuityResponse('seeded-actor-particle-is-not-a-reason', observedUnstatedServiceConcern)
      .some(check => !check.passed)).toBe(true);
  });
  it('preserves the same question only when the user directly reports their own hesitation', () => {
    const history = [...customerHistory.slice(0, -1), { role: 'user', content: '私は対応に迷っています。' }, customerHistory.at(-1)!] as CoachingChatMessage[];
    expect(assessCoachingResponseQuality({ text: observedUnstatedServiceConcern, lastUserText: customerCase.latest, historyMessages: history }).issues).toEqual([]);
  });
  it('does not use an assistant-only hesitation claim as the user report', () => {
    const history = [...customerHistory.slice(0, -1), { role: 'assistant', content: '対応に迷っているのですね。' }, customerHistory.at(-1)!] as CoachingChatMessage[];
    expect(assessCoachingResponseQuality({ text: observedUnstatedServiceConcern, lastUserText: customerCase.latest, historyMessages: history }).issues).toContain('context_mismatch');
  });
});

describe('all captured contexts retain meaning through the complete stream', () => {
  for (const mode of ['minimal', 'legacy', 'observe']) {
    it.each(capturedSyntheticCases)('keeps the seeded context in '+mode+': $name', async (scenario) => {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
      const done = await streamCandidate(scenario);
      if (scenario.name === 'actor-particle-is-not-a-reason' && mode === 'observe') {
        expect(done.qualityInitialIssues).toContain('context_mismatch');
        expect(done.qualityFinalIssues).toEqual([]);
        expect(evaluateSeededContinuityResponse(`seeded-${scenario.name}`, done.message).some(check => !check.passed)).toBe(true);
        return;
      }
      expect(evaluateSeededContinuityResponse(`seeded-${scenario.name}`, done.message).filter((check) => !check.passed), done.message).toEqual([]);
      expect(done.qualityFinalIssues).toEqual([]);
      expect(done.qualitySafetyHold).toBe(false);
    });
  }
});

describe('bounded short followup eligibility and delivery', () => {
  it.each(['はい。', 'はい、接客の仕事です。', 'いいえ。', 'いいえ、接客ではありません。'])('keeps only the established scene after the immediate profession answer: %s', (latest) => {
    expect(assessCoachingResponseQuality({ text: neutralCustomerQuestion, lastUserText: latest, historyMessages: customerHistory }).issues).toEqual([]);
  });

  it('does not interpret any work statement as an answer to the older profession question', () => {
    const history: CoachingChatMessage[] = [...customerHistory, { role: 'user', content: 'はい。' }, { role: 'assistant', content: '明日の予定はありますか？' }];
    expect(assessCoachingResponseQuality({ text: customerCase.raw, lastUserText: 'はい、接客の仕事です。', historyMessages: history }).issues).toContain('too_short');
  });

  it.each(['接客のお仕事でしょうか？その時はどう感じましたか？', '接客の仕事で次に何をするつもりですか？', '相手は「接客の仕事ですか？」と言いました。'])('does not call a compound, open, or quoted question a closed profession check: %s', (question) => {
    const history: CoachingChatMessage[] = [...customerHistory.slice(0, -1), { role: 'assistant', content: question }];
    expect(assessCoachingResponseQuality({ text: customerCase.raw, lastUserText: 'はい。', historyMessages: history }).issues).toContain('too_short');
  });

  it.each(['ACTIを解約したいです。', '私のサブスクを解約したいです。', '自分の契約を解約したいです。'])('does not borrow another-person work context for a member cancellation: %s', (report) => {
    const history: CoachingChatMessage[] = [{ role: 'user', content: '仕事は接客です。' }, { role: 'user', content: report }, { role: 'assistant', content: '接客のお仕事でしょうか？' }];
    expect(assessCoachingResponseQuality({ text: customerCase.raw, lastUserText: 'はい、接客の仕事です。', historyMessages: history }).issues).toContain('too_short');
  });

  it.each([
    'はい、接客です。話題を変えて、SNSの投稿について相談したいです。',
    '話題を変えて、SNSの投稿について相談したいです。',
    'SNSの投稿について相談したいです。',
  ])('keeps an explicit new request separate from the previous cancellation: %s', (latest) => {
    expect(assessCoachingResponseQuality({ text: topicCase.raw, lastUserText: latest, historyMessages: customerHistory }).issues).toEqual([]);
    expect(assessCoachingResponseQuality({ text: customerCase.raw, lastUserText: latest, historyMessages: customerHistory }).issues).toContain('too_short');
    const fallback = buildFinalVerifiedQualityFallback(latest, customerHistory);
    expect(fallback).toContain('SNS'); expect(fallback).toMatch(/[？?]/);
    expect(fallback).not.toMatch(/解約|キャンセル|明日|まだ書かれていない原因/);
  });

  it.each(([
    [{ role: 'user', content: '仕事で予約を担当しています。' }, { role: 'user', content: '引越しのためキャンセルしたいと連絡を受けました。' }, { role: 'assistant', content: '接客のお仕事でしょうか？' }],
    [{ role: 'user', content: '仕事で予約を担当しています。' }, { role: 'user', content: 'お客様からキャンセルの希望がありました。' }, { role: 'assistant', content: '理由について何か聞いていますか？' }, { role: 'user', content: '引越しが決まったそうです。' }, { role: 'assistant', content: '接客のお仕事でしょうか？' }],
  ] as CoachingChatMessage[][]).map((history) => ({ history })))('does not approve asking for an already-addressed reason', ({ history }) => {
    const candidate = 'そのキャンセルについて、理由を何と説明していますか？';
    const quality = assessCoachingResponseQuality({ text: candidate, lastUserText: 'はい、接客の仕事です。', historyMessages: history });
    expect(quality.issues).toContain('repeated_closing_move');
    expect(quality.issues).toContain('too_short');
  });

  it.each(['minimal', 'legacy', 'observe'])('does not permit a how-come reason re-question after a known reason in %s', async (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const histories: CoachingChatMessage[][] = [
      [{ role: 'user', content: '仕事で予約を担当しています。' }, { role: 'user', content: '引越しのためキャンセルしたいと連絡を受けました。' }, { role: 'assistant', content: '接客のお仕事でしょうか？' }],
      [{ role: 'user', content: '仕事で予約を担当しています。' }, { role: 'user', content: '相手からキャンセルの希望がありました。' }, { role: 'assistant', content: '理由について何か聞いていますか？' }, { role: 'user', content: '引越しが決まったそうです。' }, { role: 'assistant', content: '接客のお仕事でしょうか？' }],
    ];
    const raw = 'キャンセルの申し出への対応ですね。\n\nどうしてキャンセルしたいのか、何か説明はありましたか？';
    for (const history of histories) {
      const latest = 'はい、接客の仕事です。';
      expect(assessCoachingResponseQuality({ text: raw, lastUserText: latest, historyMessages: history }).issues).toContain('repeated_closing_move');
      const done = await streamCandidate({ raw, latest, history });
      if (mode === 'observe') {
        expect(done.message).toBe(raw); expect(done.qualityInitialIssues).toContain('repeated_closing_move');
      } else {
        expect(done.message).not.toContain('どうして'); expect(done.qualityFinalIssues).toEqual([]);
      }
    }
  });

  it.each(['どうですか？', 'SNSの投稿はどうですか？', '明日ひとつだけ状況を動かすなら何から始めますか？'])('does not whitelist arbitrary short questions: %s', (text) => {
    expect(assessCoachingResponseQuality({ text, lastUserText: topicCase.latest, historyMessages: customerHistory }).issues).toContain('too_short');
  });

  it('keeps psychological, internal-content and high-impact checks after the short-length exception', () => {
    expect(assessCoachingResponseQuality({ text: 'SNSの投稿について、未練がある中でどのような点で迷っていますか？', lastUserText: topicCase.latest, historyMessages: customerHistory }).issues).toContain('context_mismatch');
    expect(assessCoachingResponseQuality({ text: 'そのキャンセル連絡について、支払いを止めるには何が必要ですか？', lastUserText: customerCase.latest, historyMessages: customerHistory }).issues).toContain('unsafe_high_impact_advice');
    expect(assessCoachingResponseQuality({ text: '以下は過去の会話の保存済み要約です。SNSの投稿について、どのような点で迷っていますか？', lastUserText: topicCase.latest, historyMessages: customerHistory }).issues).toContain('internal_context_exposure');
  });

  it.each(['minimal', 'legacy', 'observe'])('still verifies the delivery boundary in %s', (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    for (const scenario of capturedSyntheticCases.filter((item) => repairedNames.has(item.name))) {
      const history = scenario.history.map((message) => ({ ...message })) as CoachingChatMessage[];
      const quality = assessCoachingResponseQuality({ text: scenario.raw, lastUserText: scenario.latest, historyMessages: history });
      const result = ensureVerifiedCoachingResolution({ resolution: { text: scenario.raw, usage: {}, modelName: 'synthetic', repairAttempted: false, repairAccepted: false, initialIssues: quality.issues, finalIssues: quality.issues }, lastUserText: scenario.latest, historyMessages: history });
      if (scenario.name === 'actor-particle-is-not-a-reason') {
        if (mode === 'observe') {
          expect(result.text).toBe(scenario.raw);
          expect(result.initialIssues).toContain('context_mismatch');
          expect(result.finalIssues).toEqual([]);
        } else {
          expect(result.text).not.toContain('迷っていますか');
          expect(result.text).toContain('キャンセル');
          expect(result.finalIssues).toEqual([]);
        }
        continue;
      }
      expect(result.text).toBe(scenario.raw); expect(result.finalIssues).toEqual([]);
    }
  });
});


describe('standard API quality evaluation continuity coverage', () => {
  it('runs the same seven fixed synthetic histories in the standard evaluation', () => {
    expect(seededContinuityScenarios).toHaveLength(7);
    for (const scenario of capturedSyntheticCases) {
      const seed = seededContinuityScenarios.find((item) => item.name === `seeded-${scenario.name}`)!;
      expect(seed.seedHistory).toEqual(scenario.history);
      expect(seed.inputs).toEqual([{ content: scenario.latest }]);
    }
  });

  it.each(capturedSyntheticCases)('rejects generic success while retaining semantic checks: $name', (scenario) => {
    const name = `seeded-${scenario.name}`;
    const checks = evaluateSeededContinuityResponse(name, '仕事全体について結論を急がず、明日5分だけ取り組んでください。');
    expect(checks.some((check) => !check.passed)).toBe(true);
  });

  it.each([
    ['short-customer-service-affirmation', '「はい、接客の仕事です」という相談ですね。解約への対応について何に困っていますか？'],
    ['already-provided-cancellation-reason', 'キャンセルのご希望ですね。どうして取りやめたいのか教えてください。'],
    ['actor-particle-is-not-a-reason', 'キャンセルの理由はすでに説明されています。返す言葉を考えましょう。'],
    ['short-customer-service-affirmation', 'あなたの役割は、解約の条件を決めることです。'],
  ])('rejects the bounded independent semantic negative control: %s', (scenarioName, message) => {
    expect(evaluateSeededContinuityResponse(`seeded-${scenarioName}`, message).some((check) => !check.passed)).toBe(true);
  });

  it('keeps an unknown reason question and a statement denying authority as positive controls', () => {
    const name = 'seeded-actor-particle-is-not-a-reason';
    expect(evaluateSeededContinuityResponse(name, 'キャンセルの理由はすでに説明されていますか？').every((check) => check.passed)).toBe(true);
    expect(evaluateSeededContinuityResponse(name, 'あなたの役割は、解約の条件を決めることではありません。キャンセルの希望を受けた後は、必要な確認を残せます。').every((check) => check.passed)).toBe(true);
  });

  it.each(['「SNSの投稿」について、どのような点を相談したいですか？', '「SNSの投稿」は、まず目的と読者を一つずつ決めてください。'])('keeps a partial topic quotation as substantive SNS support: %s', (message) => {
    expect(evaluateSeededContinuityResponse('seeded-explicit-topic-switch-after-opening-question', message).every((check) => check.passed)).toBe(true);
  });

  it('does not pass a generic body because its quotation or acknowledgement contains SNS', () => {
    const name = 'seeded-explicit-topic-switch-after-opening-question';
    for (const message of ['「話題を変えて、SNSの投稿について相談したいです」という相談ですね。次に何をしますか？', 'SNSの投稿についての相談ですね。どのような点で迷っていますか？']) {
      expect(evaluateSeededContinuityResponse(name, message).every((check) => check.passed)).toBe(false);
    }
  });

  it('recognizes a focused SNS clarification without requiring a fixed output', () => {
    const name = 'seeded-explicit-topic-switch-after-opening-question';
    expect(evaluateSeededContinuityResponse(name, 'SNSの投稿で、どんな点を一緒に整理したいですか？').every((check) => check.passed)).toBe(true);
    expect(evaluateSeededContinuityResponse(name, 'キャンセルの申し出にSNSで何と返しますか？').every((check) => check.passed)).toBe(false);
  });

  it('rejects a known-reason question even when the surrounding cancellation topic is correct', () => {
    expect(evaluateSeededContinuityResponse('seeded-already-provided-cancellation-reason', 'キャンセルについて、相手は理由を何と説明していますか？').every((check) => check.passed)).toBe(false);
  });
});

const paymentHistory: CoachingChatMessage[] = [
  { role: 'user', content: '家賃は82000円ですが、夫は毎月25000円くらいしか払わず、残りは私が負担しています。全額払ってほしいです。' },
  { role: 'assistant', content: '希望する負担額と実際の支払いは分けて確認できます。' },
  { role: 'user', content: '毎月伝えています。同じ提案はしないでください。' },
  { role: 'assistant', content: 'まず直近3か月の家賃額、相手の支払額、不足額を記録してください。その記録を使い、今後の負担額と支払期日について書面で回答を求める方法があります。' },
];
const differentPaymentRequest = '質問を返さず、今までと違う対応を具体的に答えてください。';
const repeatedWritingProposal = '次は回答期限を付けた書面で確認する方法へ切り替えてください。希望する家賃の負担額、毎月の支払日、不足した場合の扱い、回答期限を一通にまとめます。回答がない場合は、その書面と手元で確認できる支払記録を持って、夫婦問題や家計相談の窓口へ相談してください。';

describe('a different payment response after an AI writing proposal', () => {
  it('detects the repeated proposal without treating the AI proposal as a user action', () => {
    expect(assessCoachingResponseQuality({ text: repeatedWritingProposal, lastUserText: differentPaymentRequest, historyMessages: paymentHistory }).issues).toContain('repeats_rejected_move');
  });

  it.each(['minimal', 'legacy', 'observe'])('does not repeat a written demand or invent execution in %s', async (mode) => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const output = normalizeCoachingOutput(repeatedWritingProposal, differentPaymentRequest, paymentHistory);
    expect(output).not.toMatch(/書面で確認する方法へ|回答期限を一通にまとめ|書面で回答を求め|送った|送付済み|回答がなかった/);
    expect(assessCoachingResponseQuality({ text: output, lastUserText: differentPaymentRequest, historyMessages: paymentHistory }).issues).toEqual([]);
    expect(output).toMatch(/相談窓口|相談の窓口/); expect(output).not.toMatch(/76,000|76000|合意した負担|[？?]/);
    const done = await streamCandidate({ raw: repeatedWritingProposal, latest: differentPaymentRequest, history: paymentHistory });
    if (mode === 'observe') {
      expect(done.message).toBe(repeatedWritingProposal);
      expect(done.qualityInitialIssues).toContain('repeats_rejected_move');
    } else {
      expect(done.message).not.toMatch(/書面で確認する方法へ|回答期限を一通にまとめ|書面で回答を求め|送った|送付済み|回答がなかった/);
      expect(done.message).toMatch(/相談窓口|相談の窓口/); expect(done.qualityFinalIssues).toEqual([]);
    }
  });

  it('does not pull an explicit new SNS topic back to the older payment proposal', () => {
    const latest = '話題を変えて、SNSの投稿について相談したいです。';
    const output = normalizeCoachingOutput(topicCase.raw, latest, paymentHistory);
    expect(output).toBe(topicCase.raw); expect(output).not.toMatch(/家賃|夫婦|相談窓口/);
  });

  it('does not discard a first writing suggestion when no writing proposal was previously given', () => {
    expect(assessCoachingResponseQuality({ text: repeatedWritingProposal, lastUserText: differentPaymentRequest, historyMessages: paymentHistory.slice(0, 2) }).issues).not.toContain('repeats_rejected_move');
  });
});
