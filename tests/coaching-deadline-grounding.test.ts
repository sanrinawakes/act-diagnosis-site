import { afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ raw: '', repairs: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => ({ stream: (async function* () { yield { text: () => transport.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }),
  sendMessage: async () => { transport.repairs++; return { response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }; },
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { throw new Error('NETWORK_DISABLED'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { throw new Error('ALERT_DISABLED'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, buildGeminiParts, createJsonLineStream, ensureVerifiedCoachingResolution, normalizeCoachingOutput, type CoachingChatMessage } from '../src/lib/coaching-gemini';
import { containsDeadlineOutcomeAssurance } from '../src/lib/coaching-deadline-language.mjs';

// Synthetic standard-suite delivery, not a recording of provider-original text.
export const deadlineCandidate = '火曜午前10時までの締め切りがあるのですね。\n\n初めて使う人向けの資料として、一枚目の利用目的と二枚目の利用手順の骨組みがあれば、担当者への提出期限に十分間に合います。\n\n火曜午前10時までに完成させるために、まずは二枚目の利用手順を書き出す作業から進められますか？';
export const deadlineLatest = '担当者から、資料は火曜午前10時までと言われました。';
export const deadlineHistory: CoachingChatMessage[] = [
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
    "content": "初めてサービスを使う人向けなら、専門用語を残す数を減らすより、最初に読む一文を日常語へ置き換える方が伝わりやすくなります。今日は一枚目にある専門用語を一つ選び、その言葉を「初めて使う人にも意味が伝わる言い方」に置き換えてください。"
  },
  {
    "role": "user",
    "content": "説明する順番にも迷っています。"
  },
  {
    "role": "assistant",
    "content": "企画の説明資料で、説明する順番に迷っているのですね。\n\n初めて使う人向けの資料では、「これで何ができるか」を最初に伝え、その後に「どうやって使うか」を配置すると、全体像がスムーズに伝わりやすくなります。\n\n企画の説明資料で、一番最初に伝える予定の内容は何ですか？"
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
  }
];
afterEach(() => vi.unstubAllEnvs());
const assess = (text: string, latest = deadlineLatest, history = deadlineHistory) => assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: history }).issues;

describe('deadline confidence and user-grounded recovery', () => {
  for (const candidate of [deadlineCandidate, deadlineCandidate.replace('担当者への提出期限に十分間に合います', '予定通り提出できます')]) {
  it.each(['minimal', 'legacy', 'observe'])('detects an unsupported deadline outcome through full streaming in %s: '+candidate.slice(60, 110), async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode); transport.raw = candidate; transport.repairs = 0;
    let saved = '';
    const stream = createJsonLineStream({ systemPrompt: 'Synthetic deadline regression.', historyMessages: deadlineHistory,
      lastUserParts: buildGeminiParts(deadlineLatest, [], deadlineHistory), onDone: async (_usage, completion) => { saved = completion.message; return {}; } });
    const reader = stream.getReader(); const decoder = new TextDecoder(); let data = '';
    while (true) { const next = await reader.read(); if (next.done) break; data += decoder.decode(next.value); }
    const events = data.trim().split('\n').map(line => JSON.parse(line));
    const dones = events.filter(event => event.type === 'done'); expect(dones).toHaveLength(1);
    const done = dones[0]; expect(done.completionStatus).toBe('complete'); expect(done.finalizationStatus).toBe('complete');
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
    expect(saved).toBe(done.message); expect(done.qualityInitialIssues).toContain('context_mismatch');
    if (mode === 'observe') { expect(done.message).toBe(candidate); expect(done.qualityFinalIssues).toEqual([]); expect(done.qualityRepairAccepted).not.toBe(true); }
    else { expect(done.message).not.toMatch(/十分間に合います|予定通り提出できます/); expect(done.message).toContain('火曜午前10時');
      expect(done.message).toMatch(/残|まだ|必要/); expect(done.message).toMatch(/時間/); expect(done.qualityFinalIssues).toEqual([]); }
  });
  }
  it.each([
    '骨組みがあれば、提出期限に十分間に合います。',
    'この順番なら、期限までに必ず間に合います。',
    '担当者へ「期限に必ず間に合います」と伝えてください。',
    '担当者が言うなら、期限に十分間に合います。',
    '期限に間に合いますとは限りませんが、この構成なら必ず間に合います。',
  ])('flags an assistant-created assurance even with a condition or proposed quote: %s', text => {
    expect(assess(text)).toContain('context_mismatch');
  });
  it.each([
    '期限に向けて、一枚目の利用目的を一文に絞ってください。',
    '間に合うかは、残作業と使える時間を確認しないと判断できません。',
    '期限までに間に合いそうですか？',
    '期限までに間に合うでしょうか？',
    '期限には間に合いますとは限りません。',
    '期限には間に合いますという意味ではありません。',
    '期限には絶対に間に合いませんとは言えません。',
    '期限には必ず完成できますとは断言できません。',
    '残作業を確認して、期限に間に合うかを考えてください。',
    '期限に間に合わせるなら、一枚目の利用目的を先に見直してください。',
  ])('preserves a goal, uncertainty or question without asserting feasibility: %s', text => {
    expect(assess(text)).not.toContain('context_mismatch');
  });
  it('allows a user-reported quote without adopting it as the assistant conclusion', () => {
    const latest = '担当者から「期限に必ず間に合います」と言われました。資料の準備について考えています。';
    expect(assess('担当者から「期限に必ず間に合います」と言われたのですね。残作業はどの部分ですか？', latest)).not.toContain('context_mismatch');
    expect(assess('担当者から「期限に必ず間に合います」と言われたなら、十分間に合います。', latest)).toContain('context_mismatch');
  });
  it('does not treat a negated user quote as a reported promise', () => {
    const latest = '担当者から「期限に必ず間に合います」と言われていません。資料の作業について考えています。';
    expect(assess('担当者から「期限に必ず間に合います」と言われたのですね。', latest)).toContain('context_mismatch');
    expect(assess('担当者は「期限に必ず間に合います」とは言っていません。', latest)).not.toContain('context_mismatch');
  });
  it.each(['', '。'])('preserves faithful and negated quotes with punctuation: %s', punctuation => {
    const latest = `担当者から「期限に必ず間に合います${punctuation}」と言われました。資料の作業について考えています。`;
    const negativeLatest = `資料の作業について考えています。担当者は「期限に必ず間に合います${punctuation}」とは言っていません。`;
    const faithful = `担当者から「期限に必ず間に合います${punctuation}」と言われたのですね。`;
    const negated = `担当者は「期限に必ず間に合います${punctuation}」とは言っていません。`;
    expect(assess(faithful, latest)).not.toContain('context_mismatch');
    expect(assess(negated, negativeLatest)).not.toContain('context_mismatch');
    expect(assess(`担当者に「期限に必ず間に合います${punctuation}」と伝えてください。`, deadlineLatest)).toContain('context_mismatch');
  });
  it('does not apply a work-deadline guard to another topic', () => {
    expect(assess('その電車に間に合います。', '話題を変えて、言葉の使い方を確認したいです。', [{ role: 'user', content: deadlineLatest }])).not.toContain('context_mismatch');
  });
  it.each(['金曜日午後3時', '金曜午後３時', '金曜午後3時0分'])('allows equivalent spelling of the user-provided time: %s', time => {
    expect(assess(`${time}の締切に向けて、一枚目の利用目的を見直してください。`, '説明資料の締切は金曜午後3時です。', [])).not.toContain('context_mismatch');
  });

  const requests = ['目的の説明が長くなりすぎています。', '3回前に伝えた締切時刻も踏まえて、今日最初に直す箇所を一つだけ、質問なしで答えてください。'];
  const histories: [string, CoachingChatMessage[], string | null][] = [
    ['Friday', [{ role: 'user', content: 'サービスの説明資料を作っています。締切は金曜午後3時です。一枚目は利用目的で、二枚目は利用手順です。' }], '金曜午後3時'],
    ['latest update', [{ role: 'user', content: '説明資料の期限は火曜午前10時です。' }, { role: 'user', content: '期限は金曜午後3時に変更されました。' }], '金曜午後3時'],
    ['partial weekday update', [{ role: 'user', content: '説明資料の締切は火曜午前10時です。' }, { role: 'user', content: '締切は金曜に変更されました。' }], null],
    ['latest weekday declaration', [{ role: 'user', content: '説明資料の締切は火曜午前10時です。' }, { role: 'user', content: '締切は金曜です。' }], null],
    ['change question', [{ role: 'user', content: '説明資料の締切は火曜午前10時です。' }, { role: 'user', content: '締切は金曜に変更されましたか？' }], '火曜午前10時'],
    ['change denied', [{ role: 'user', content: '説明資料の締切は火曜午前10時です。' }, { role: 'user', content: '締切は金曜に変更されていません。' }], '火曜午前10時'],
    ['same-sentence correction', [{ role: 'user', content: '説明資料の期限は火曜午前10時です。' }, { role: 'user', content: '火曜午前10時ではなく、金曜午後3時に変更されました。' }], '金曜午後3時'],
    ['assistant error', [{ role: 'user', content: '説明資料の期限は金曜午後3時です。' }, { role: 'assistant', content: '締切は火曜午前10時ですね。' }], '金曜午後3時'],
    ['not supplied', [{ role: 'user', content: 'サービスの説明資料を作っています。一枚目は利用目的で二枚目は利用手順です。' }], null],
    ['assistant only', [{ role: 'user', content: '説明資料を作っています。' }, { role: 'assistant', content: '締切は火曜午前10時ですね。' }], null],
    ['negated', [{ role: 'user', content: '説明資料の期限は火曜午前10時です。' }, { role: 'user', content: '火曜午前10時は締切ではありません。期限はまだ未定です。' }], null],
    ['negated report', [{ role: 'user', content: '説明資料の期限は火曜午前10時です。' }, { role: 'user', content: '期限は金曜午後3時と言われていません。' }], null],
    ['cancelled', [{ role: 'user', content: '説明資料の期限は火曜午前10時です。' }, { role: 'user', content: '締切はなくなりました。' }], null],
    ['question only', [{ role: 'user', content: '説明資料の締切は金曜午後3時ですか？' }], null],
    ['old topic', [{ role: 'user', content: '別の資料の期限は火曜午前10時です。' }, { role: 'user', content: '話題を変えて、新サービスの説明資料について相談します。一枚目は利用目的です。' }], null],
    ['old topic in same utterance', [{ role: 'user', content: '前の資料の期限は火曜午前10時です。話題を変えて、新しい説明資料を作ります。一枚目は利用目的です。' }], null],
  ];
  for (const request of requests) {
    it.each(histories)('grounds the deadline in current user facts for '+request+': %s', (_name, history, expected) => {
      const text = buildFinalVerifiedQualityFallback(request, history);
      if (expected) expect(text).toContain(expected); else expect(text).not.toMatch(/[月火水木金土日]曜(?:日)?(?:午前|午後)?\d+時/);
      if (expected !== '火曜午前10時') expect(text).not.toContain('火曜午前10時');
      expect(text).toMatch(/一枚目|利用目的/); expect(text).not.toMatch(/[？?]/); expect(assess(text, request, history)).toEqual([]);
      if (request.includes('3回前')) expect(text).not.toMatch(/いま長くなっている/);
    });
  }
});

const completionVariants = [
  'この構成なら締切までに予定通り提出できます',
  'この骨組みがあれば期限までに仕上げられます',
  '今から始めれば期日までに完了できます',
  'この手順なら締切までに間に合うはずだ',
  'これだけ直せば期限に間に合わせられます',
  '骨組みがあれば、予定通り提出できます',
  '骨組みがあれば、予定どおり提出できます',
];
describe('deadline completion inflections without weakening boundaries', () => {
  it.each(completionVariants)('rejects a conditional sufficiency claim: %s', text => {
    expect(containsDeadlineOutcomeAssurance(text + '。')).toBe(true);
    expect(assess(text + '。')).toContain('context_mismatch');
  });
  it.each([
    '締切までに提出できますか？', '期限までに仕上げられますか？', '期日までに完了できますか？',
    '締切までに間に合うはずですか？', '期限に間に合わせられますか？',
    '期限に間に合わせるため、一枚目の利用目的を見直してください。',
    '締切までに提出できますとは断言できません。', '期限までに仕上げられますとは言えません。',
    '期日までに完了できますという意味ではありません。', '期限に間に合わせられますとは限りません。',
    '一枚目の内容だけを提出できます。', '文章を短く整えて仕上げられます。',
    '期限が違っても、同じ方法で提出できます。',
    '予定通り提出できますか？', '予定通り提出できますとは限りません。',
    '予定通り提出するため、一枚目の利用目的を確認してください。',
  ])('preserves a question, goal, negation or ordinary capability: %s', text => {
    expect(containsDeadlineOutcomeAssurance(text)).toBe(false);
    expect(assess(text)).not.toContain('context_mismatch');
  });
});

// Independently proposed fixed controls; all text is synthetic.
const independentDeadlineControls = [
  {
    "kind": "reject",
    "text": "一枚目の利用目的と二枚目の利用手順の骨組みがあれば、担当者への提出期限に十分間に合います。",
    "reason": "Conditional names an artifact state but supplies no remaining workload, review requirement, or available time; still asserts sufficiency."
  },
  {
    "kind": "reject",
    "text": "今から始めれば、火曜午前10時までに必ず完成できます。",
    "reason": "Action conditional does not ground guaranteed future completion."
  },
  {
    "kind": "reject",
    "text": "この進め方なら、締切は大丈夫です。",
    "reason": "Reassurance about deadline success with no estimate/evidence."
  },
  {
    "kind": "reject",
    "text": "二枚だけに絞れば、今日中に終わります。",
    "reason": "Reducing scope does not prove required work duration or acceptance."
  },
  {
    "kind": "reject",
    "text": "その締切には絶対に間に合いません。",
    "reason": "Unsupported failure certainty is also an ungrounded future-feasibility conclusion."
  },
  {
    "kind": "reject",
    "text": "これなら火曜の提出に必ず間に合うと思いませんか？",
    "reason": "Question ending contains a leading guaranteed-result premise; punctuation alone is not a safe question exemption."
  },
  {
    "kind": "allow",
    "text": "期限に間に合うかは、残作業と使える時間を確認しないと判断できません。今の資料で、まだ説明を書けていないページはありますか？",
    "reason": "Explicit uncertainty plus concrete feasibility question, no success assertion."
  },
  {
    "kind": "allow",
    "text": "火曜午前10時までに間に合いそうですか？",
    "reason": "Asks the user to assess feasibility; no AI assertion of sufficiency."
  },
  {
    "kind": "allow",
    "user": "担当者から「必ず火曜午前10時までに終わらせて」と言われました。",
    "text": "担当者から「必ず火曜午前10時までに終わらせて」と言われたのですね。",
    "reason": "Attributed user-provided request, not AI adoption of outcome as guaranteed."
  },
  {
    "kind": "allow",
    "user": "間に合わないかもしれないと心配です。",
    "text": "「間に合わないかもしれない」と心配しているのですね。",
    "reason": "Faithful quotation of uncertainty/feeling, no unsupported success or failure conclusion."
  },
  {
    "kind": "allow",
    "text": "期限に間に合わせるため、まず各ページに必要な説明があるか確認してください。",
    "reason": "Goal-oriented proposed action, not a claim the action ensures completion."
  },
  {
    "kind": "allow",
    "user": "残作業の見積もりは30分、締切まで確保済みの作業時間は2時間です。",
    "text": "その見積もりでは、確保した2時間から30分を引くと1時間半が残ります。見積もりが変われば余裕も変わります。",
    "reason": "Deterministic arithmetic grounded in all stated premises and qualified as estimate, no guaranteed final outcome."
  },
  {
    "kind": "allow",
    "user": "昨日の提出は締切に間に合いました。",
    "text": "昨日の提出は締切に間に合ったのですね。",
    "reason": "User-reported past outcome, not future prediction."
  },
  {
    "kind": "allow",
    "user": "今日はもう何も考えたくありません。",
    "text": "今日はここで終えて大丈夫です。",
    "reason": "Permission to stop, not feasibility or third-party outcome guarantee."
  },
  {
    "kind": "allow",
    "text": "文章を短くするために、最初の説明を一文にできます。",
    "reason": "Ordinary edit option/capability; broad matching of できる must not trigger a deadline safeguard."
  }
];
describe("independent deadline outcome controls", () => {
  it.each(independentDeadlineControls)("$kind: $text", control => {
    expect(containsDeadlineOutcomeAssurance(control.text, control.user ? [control.user] : [])).toBe(control.kind === 'reject');
    // The proposal's explicit user override is its own topic. Do not append
    // document history to the rest-permission or past-outcome controls.
    const issues = assess(control.text, control.user || deadlineLatest, control.user ? [] : deadlineHistory);
    if (control.kind === "reject") expect(issues).toContain("context_mismatch");
    else expect(issues).not.toContain("context_mismatch");
  });
});

const closureCases = [
  { latest: '昨日の提出は締切に間に合いました。', raw: '昨日の提出は締切に間に合ったのですね。', subject: /提出|間に合った/ },
  { latest: '今日はもう何も考えたくありません。', raw: '今日はここで終えて大丈夫です。', subject: /休|終えて/ },
];
describe('completed submission and explicit rest after document history', () => {
  it.each(closureCases)('does not add psychology or reassign the old task for $latest', ({ latest, subject }) => {
    const text = normalizeCoachingOutput('頑張ったから安心しているのですね。明日は資料を書き直してください。', latest, deadlineHistory);
    expect(text).toMatch(subject); expect(text).not.toMatch(/安心|頑張|明日|資料/);
  });
  for (const mode of ['minimal', 'legacy']) {
    it('does not require an old work-domain keyword in a grounded rest acknowledgement: '+mode, () => {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
      expect(assess('今日はゆっくり休んでください。', '仕事で疲れました。')).toEqual([]);
    });
    it.each(closureCases)('keeps a valid closure through every quality boundary in '+mode+': $latest', async ({ latest, raw, subject }) => {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode); transport.raw = raw; transport.repairs = 0;
      const issues = assess(raw, latest); expect(issues).toEqual([]);
      expect(normalizeCoachingOutput(raw, latest, deadlineHistory)).toBe(raw);
      const verified = ensureVerifiedCoachingResolution({ resolution: { text: raw, usage: {}, modelName: 'synthetic', repairAttempted: false,
        repairAccepted: false, initialIssues: issues, finalIssues: issues }, lastUserText: latest, historyMessages: deadlineHistory });
      expect(verified.text).toBe(raw);
      const fallback = buildFinalVerifiedQualityFallback(latest, deadlineHistory);
      expect(fallback).toMatch(subject); expect(fallback).not.toMatch(/企画|資料|仕事全体|明日|[？?]|疲れ|頑張|不安/);
      let saved = '';
      const stream = createJsonLineStream({ systemPrompt: 'Synthetic completed submission or rest.', historyMessages: deadlineHistory,
        lastUserParts: buildGeminiParts(latest, [], deadlineHistory), onDone: async (_usage, completion) => { saved = completion.message; return {}; } });
      const reader = stream.getReader(); const decoder = new TextDecoder(); let wire = '';
      while (true) { const next = await reader.read(); if (next.done) break; wire += decoder.decode(next.value); }
      const events = wire.trim().split('\n').map(line => JSON.parse(line)); const done = events.find(event => event.type === 'done');
      // The existing immediate-rest path now recognizes the polite request.
      // It uses its established one-sentence rest response before any model.
      const delivered = latest.includes('考えたく') ? '今日はゆっくり休んでください。' : raw;
      expect(done.message).toBe(delivered); expect(done.qualityFinalIssues).toEqual([]);
      expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(delivered); expect(saved).toBe(delivered);
      expect(transport.repairs).toBe(0);
    });
  }
  it.each([
    '昨日の提出は締切に間に合いましたか？',
    '昨日の提出は締切に間に合いませんでした。',
    '昨日の提出は締切に間に合いました。次の資料の準備を相談したいです。',
    '「昨日の提出は締切に間に合いました」と言われました。',
  ])('does not turn a question, failure, second request or quote into a success acknowledgement: %s', latest => {
    expect(normalizeCoachingOutput('次の資料の準備について伺います。', latest, deadlineHistory)).not.toBe(closureCases[0].raw);
  });
  it.each([
    '今日はもう何も考えたくありませんか？',
    '「今日はもう何も考えたくありません」と言われました。',
    '今日はもう何も考えたくありません、という意味ではありません。',
    '今日はもう何も考えたくありません。でも資料の相談を続けたいです。',
  ])('does not close a polite question, quote, negation or continuing request: %s', latest => {
    expect(normalizeCoachingOutput('資料の利用目的について相談を続けられます。', latest, deadlineHistory)).not.toBe('今日はゆっくり休んでください。');
  });
});

// Existing bounded batch cases only; all inputs are synthetic.
const knownBatchRegressions = [
  {
    "id": "original-10",
    "latest": "間に合わないかもしれないと心配です。",
    "history": [
      {
        "role": "user",
        "content": "説明資料の期限は火曜午前10時です。"
      }
    ],
    "raw": "「間に合わないかもしれない」と心配しているのですね。",
    "stale": false
  },
  {
    "id": "original-12",
    "latest": "残作業の見積もりは30分、締切まで確保済みの作業時間は2時間です。",
    "history": [],
    "raw": "その見積もりでは、確保した2時間から30分を引くと1時間半が残ります。見積もりが変われば余裕も変わります。",
    "stale": false
  },
  {
    "id": "quote-reported-0",
    "latest": "担当者から「期限に必ず間に合います」と言われました。資料の作業について考えています。",
    "history": [
      {
        "role": "user",
        "content": "説明資料の期限は火曜午前10時です。"
      }
    ],
    "raw": "担当者から「期限に必ず間に合います」と言われたのですね。",
    "stale": false
  },
  {
    "id": "quote-reported-1",
    "latest": "担当者から「期限に必ず間に合います。」と言われました。資料の作業について考えています。",
    "history": [
      {
        "role": "user",
        "content": "説明資料の期限は火曜午前10時です。"
      }
    ],
    "raw": "担当者から「期限に必ず間に合います。」と言われたのですね。",
    "stale": false
  },
  {
    "id": "partial-Friday-no-hour-2",
    "latest": "3回前に伝えた締切時刻も踏まえて、今日最初に直す箇所を一つだけ、質問なしで答えてください。",
    "history": [
      {
        "role": "user",
        "content": "サービスの説明資料を作っています。一枚目は利用目的で二枚目は利用手順です。"
      },
      {
        "role": "user",
        "content": "説明資料の締切は火曜午前10時です。"
      },
      {
        "role": "user",
        "content": "締切は金曜に変更されました。"
      },
      {
        "role": "user",
        "content": "今日は一枚目から直そうと思います。"
      },
      {
        "role": "user",
        "content": "目的の説明が長くなりすぎています。"
      }
    ],
    "raw": "火曜午前10時の締切に間に合わせるなら、今日最初に直すのは一枚目の利用目的です。いま長くなっている説明を、「このサービスで何ができるか」が一文で伝わる長さまで削ってください。",
    "stale": true
  },
  {
    "id": "cancelled-deadline-2",
    "latest": "3回前に伝えた締切時刻も踏まえて、今日最初に直す箇所を一つだけ、質問なしで答えてください。",
    "history": [
      {
        "role": "user",
        "content": "サービスの説明資料を作っています。一枚目は利用目的で二枚目は利用手順です。"
      },
      {
        "role": "user",
        "content": "説明資料の締切は火曜午前10時です。"
      },
      {
        "role": "user",
        "content": "締切はなくなりました。"
      },
      {
        "role": "user",
        "content": "今日は一枚目から直そうと思います。"
      },
      {
        "role": "user",
        "content": "目的の説明が長くなりすぎています。"
      }
    ],
    "raw": "火曜午前10時の締切に間に合わせるなら、今日最初に直すのは一枚目の利用目的です。いま長くなっている説明を、「このサービスで何ができるか」が一文で伝わる長さまで削ってください。",
    "stale": true
  }
];

describe('known batch deadline premises and faithful short replies', () => {
  const currentDeadline: CoachingChatMessage[] = [{ role: 'user', content: '説明資料の締切は火曜午前10時です。' }, { role: 'user', content: '締切はなくなりました。' }];
  it.each([
    'もし金曜午後3時が締切なら、一枚目の利用目的を先に見直してください。',
    '締切が金曜午後3時だったら、一枚目の利用目的から見直してください。',
  ])('permits a genuine hypothetical date rather than asserting the cancelled deadline: %s', text => {
    expect(assess(text, '目的の説明が長くなりすぎています。', currentDeadline)).not.toContain('context_mismatch');
  });
  it('does not treat a conditional action as a hypothetical deadline fact', () => {
    expect(assess('もし火曜午前10時の締切に間に合わせるなら、一枚目の利用目的を見直してください。', '目的の説明が長くなりすぎています。', currentDeadline)).toContain('context_mismatch');
  });
  it('does not exempt another asserted date in the same sentence as a genuine hypothetical', () => {
    expect(assess('もし金曜午後3時が締切なら一枚目を直し、火曜午前10時の期限に向けて手順を確認してください。', '目的の説明が長くなりすぎています。', currentDeadline)).toContain('context_mismatch');
  });
  it('does not exempt invented worry or an incorrect reported quote as a grounded short reply', () => {
    expect(assess('「間に合わないかもしれない」と心配しているのですね。', '期限について確認しています。', currentDeadline)).toContain('too_short');
    expect(assess('担当者から「必ず完成できます」と言われたのですね。', '担当者から「期限に必ず間に合います」と言われました。', currentDeadline)).not.toEqual([]);
  });
  it('does not close an attributed report with an additional request or stated feeling', () => {
    const raw = '資料のどの部分について相談したいですか？';
    for (const suffix of ['どう進めればよいか教えてください。', 'でも私は心配です。', '作業手順を決めてください。', 'ただし、その後締切が変わりました。']) {
      const latest = '担当者から「期限に必ず間に合います」と言われました。' + suffix;
      expect(normalizeCoachingOutput(raw, latest, currentDeadline)).not.toBe('担当者から「期限に必ず間に合います」と言われたのですね。');
    }
  });
  it('checks estimate arithmetic against the explicit premises without inventing missing time', () => {
    const latest = '残作業の見積もりは30分、締切まで確保済みの作業時間は2時間です。';
    expect(normalizeCoachingOutput('その見積もりでは3時間が残ります。', latest, [])).toContain('1時間半');
    expect(assess('その見積もりでは、確保した2時間から30分を引くと1時間半が残ります。見積もりが変われば余裕も変わります。', '残作業の見積もりは30分です。', [])).toContain('too_short');
  });
  for (const mode of ['minimal', 'legacy']) {
    it.each(knownBatchRegressions)('keeps the current premise through fullstream in '+mode+': $id', async scenario => {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode); transport.raw = scenario.raw; transport.repairs = 0;
      const history = scenario.history as CoachingChatMessage[];
      const issues = assess(scenario.raw, scenario.latest, history);
      if (scenario.stale) expect(issues).toContain('context_mismatch'); else expect(issues).toEqual([]);
      let saved = '';
      const stream = createJsonLineStream({systemPrompt:'Synthetic existing known-case replay.',historyMessages:history,
        lastUserParts:buildGeminiParts(scenario.latest,[],history),onDone:async(_usage,completion)=>{saved=completion.message;return{};}});
      const reader=stream.getReader();const decoder=new TextDecoder();let wire='';
      while(true){const chunk=await reader.read();if(chunk.done)break;wire+=decoder.decode(chunk.value);}
      const events=wire.trim().split('\n').map(line=>JSON.parse(line));const done=events.find(event=>event.type==='done');
      expect(done.completionStatus).toBe('complete');expect(done.finalizationStatus).toBe('complete');
      expect(events.filter(event=>event.type==='chunk').map(event=>event.text).join('')).toBe(done.message);expect(saved).toBe(done.message);
      expect(done.qualityFinalIssues).toEqual([]);
      if(scenario.stale){expect(done.message).not.toMatch(/火曜|10時|[？?]/);expect(done.message).toMatch(/一枚目|利用目的/);}
      else{expect(done.message).toBe(scenario.raw);expect(transport.repairs).toBe(0);}
      expect(done.message).not.toMatch(/という相談ですね|まだ書かれていない原因|確認できる事実を一つ/);
    });
  }
});
