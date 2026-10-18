import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const forbidden = vi.hoisted(() => ({ sdk: 0, provider: 0, alerts: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({
  getGenAI: () => { forbidden.sdk++; throw new Error('SDK_FORBIDDEN'); },
}));
vi.mock('@/lib/coaching-provider-candidates', () => ({
  generateCoachingProviderCandidate: async () => {
    forbidden.provider++; throw new Error('PROVIDER_FORBIDDEN');
  },
}));
vi.mock('@/lib/coaching-alerts', () => ({
  sendCoachingAlert: async () => { forbidden.alerts++; throw new Error('ALERT_FORBIDDEN'); },
}));

import {
  assessCoachingResponseQuality,
  buildFinalVerifiedQualityFallback,
  ensureVerifiedCoachingResolution,
  normalizeCoachingOutput,
  type CoachingChatMessage,
} from '../src/lib/coaching-gemini';

// Anonymous finite boundaries found in the new answer-continuation helper's
// independent static review. These are not new customer or provider samples.
const repeatedAnswer = '必要な確認だと伝えましたが、その人は確認しなくてよいという様子でした。';
const fixtures = [
  {
    name: 'solo-completion-emotion-does-not-create-another-person',
    history: [
      { role: 'user', content: '一人で制作していた作品が完成しました。' },
      { role: 'assistant', content: '一人で作品を完成させた時、どんな気持ちでしたか？' },
    ] as CoachingChatMessage[],
    latest: 'とても嬉しかったです。',
    unsupported: /相手|どのように対応してほしかった/,
  },
  {
    name: 'desired-words-do-not-become-words-already-spoken',
    history: [
      { role: 'user', content: '作品を完成させた時、家族にねぎらってほしかったです。' },
      { role: 'assistant', content: 'どんな言葉をかけてほしかったですか？' },
    ] as CoachingChatMessage[],
    latest: 'よく頑張ったねと言ってほしかったです。',
    unsupported: /その言葉を伝えた時|相手からは[^。！？\n]*返事/,
  },
  {
    name: 'identical-answer-resends-after-service-notices-continue-the-original-turn',
    history: [
      { role: 'user', content: '同僚が共同作業の確認を後回しにしています。' },
      { role: 'assistant', content: 'その人には、どんな言葉で返したのですか？' },
      { role: 'user', content: repeatedAnswer },
      { role: 'assistant', content: '申し訳ありません。今の内容を取り違えないように返答を整え直しています。推測で話を進めたり、すでに答えてくださったことを聞き直したりせず、直前までの内容を確認して続けます。お手数ですが、今のメッセージをそのままもう一度送ってください。' },
      { role: 'user', content: repeatedAnswer },
      { role: 'assistant', content: '申し訳ありません。直前までの流れに沿った返答になっていないため、ここで回答を整え直します。同じ質問を繰り返したり、書かれていない事情を決めつけたりせずに続けます。お手数ですが、最後のメッセージをもう一度だけ送ってください。' },
    ] as CoachingChatMessage[],
    latest: repeatedAnswer,
    unsupported: /という相談ですね|まだ書かれていない原因を推測せず|(?:相談したい出来事|確認できる事実)[^。！？\n]{0,80}(?:一つ|書いて|教えて)/,
  },
  {
    name: 'question-with-full-stop-is-not-an-answer-to-the-previous-question',
    history: [
      { role: 'user', content: '同僚が共同作業の確認を後回しにしています。' },
      { role: 'assistant', content: 'その人には、どんな言葉で返したのですか？' },
    ] as CoachingChatMessage[],
    latest: '必要な確認だと伝えました。次は、どんな言葉で返せますか。',
    unsupported: /「[^」]*次は、どんな言葉で返せますか[。]?[^」]*」|その言葉を伝えた時|相手からは[^。！？\n]*返事|という相談ですね|まだ書かれていない原因を推測せず|確認できる事実[^。！？\n]{0,80}(?:一つ|書いて|教えて)/,
  },
];
const candidate = '今の相談について、まだ書かれていない事情を決めつけず、実際に起きたことと今話したいことを分けて考えます。最初に、相談したい出来事の中から、確認できる事実を一つだけこの画面に書いてください。相手の意図や自分の評価ではなく、実際に起きたことだけで大丈夫です。';
const actuals: Array<Record<string, unknown>> = [];
const originalMode = process.env.COACHING_OUTPUT_PIPELINE_MODE;
vi.stubGlobal('fetch', async () => { forbidden.fetch++; throw new Error('FETCH_FORBIDDEN'); });
afterEach(() => {
  if (originalMode === undefined) delete process.env.COACHING_OUTPUT_PIPELINE_MODE;
  else process.env.COACHING_OUTPUT_PIPELINE_MODE = originalMode;
});
afterAll(() => {
  const output = process.env.ACTI_ANSWER_CONTEXT_BOUNDARY_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({
    scope: 'Four anonymous answer-continuation boundaries plus one faithful quoted-report control; pure public functions only',
    candidateOrigin: 'LOCAL_SYNTHETIC_FIXTURE_NOT_PROVIDER_RAW',
    actuals, forbidden,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  vi.unstubAllGlobals();
  expect(forbidden).toEqual({ sdk: 0, provider: 0, alerts: 0, fetch: 0 });
});

describe('answered-turn continuation preserves actor and event status', () => {
  it.each(fixtures)('$name', ({ name, history, latest, unsupported }) => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';
    const assess = (text: string) => assessCoachingResponseQuality({
      text, lastUserText: latest, historyMessages: history,
    });
    const verify = (text: string) => {
      const quality = assess(text);
      return ensureVerifiedCoachingResolution({
        resolution: {
          text, usage: {}, provider: 'local', modelName: 'synthetic-answer-boundary',
          repairAttempted: false, repairAccepted: false,
          initialIssues: quality.issues, finalIssues: quality.issues,
        },
        lastUserText: latest, historyMessages: history,
      });
    };
    const builder = buildFinalVerifiedQualityFallback(latest, history);
    const builderQuality = assess(builder);
    const normalized = normalizeCoachingOutput(candidate, latest, history);
    const normalizedQuality = assess(normalized);
    const normalizedVerified = verify(normalized);
    const direct = verify(candidate);
    actuals.push({ name, history, latest, candidate, initial: assess(candidate),
      builder, builderQuality, normalized, normalizedQuality, normalizedVerified, direct });
    for (const text of [builder, normalizedVerified.text, direct.text]) {
      expect(text.trim()).not.toBe('');
      expect(text).not.toMatch(unsupported);
      expect(text).not.toMatch(/申し訳ありません。この会話では、正しく返答を続けられない状態|最後のメッセージをもう一度/);
    }
    expect(normalizedVerified.finalIssues).toEqual([]);
    expect(direct.finalIssues).toEqual([]);
  });
  it('reported-third-party-wording-question-is-not-the-users-draft-request', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';
    const history: CoachingChatMessage[] = [
      { role: 'user', content: '同僚との共同作業について話しています。' },
      { role: 'assistant', content: '同僚からは、どんな返事がありましたか？' },
    ];
    const latest = '同僚から「次は、どんな言葉で返せますか」と聞かれました。';
    const candidate = '次にどんな言葉で返せるかを、同僚から尋ねられたのですね。これは、同僚から受けた質問を共有してくださった発言として受け取ります。相手の質問を、あなた自身がこちらに新しい文案を求めているという意味へ置き換えず、誰が誰に尋ねた内容なのかを保って話を続けます。';
    const quality = assessCoachingResponseQuality({ text: candidate, lastUserText: latest, historyMessages: history });
    const verified = ensureVerifiedCoachingResolution({
      resolution: {
        text: candidate, usage: {}, provider: 'local', modelName: 'synthetic-reported-wording-question',
        repairAttempted: false, repairAccepted: false,
        initialIssues: quality.issues, finalIssues: quality.issues,
      },
      lastUserText: latest, historyMessages: history,
    });
    actuals.push({ name: 'reported-third-party-wording-question-is-not-the-users-draft-request', history, latest, candidate, quality, verified });
    expect(candidate.length).toBeGreaterThanOrEqual(90);
    expect(quality.issues).toEqual([]);
    expect(verified.text).toBe(candidate);
    expect(verified.finalIssues).toEqual([]);
  });

});
