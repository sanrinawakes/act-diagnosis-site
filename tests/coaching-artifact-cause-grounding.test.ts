import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ raw: '', primary: 0, repair: 0, provider: 0, fetch: 0, alerts: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => { transport.primary++; return { stream: (async function* () { yield { text: () => transport.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }; },
  sendMessage: async () => { transport.repair++; return { response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }; },
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.provider++; throw Error('PROVIDER_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alerts++; throw Error('ALERT_FORBIDDEN'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution, normalizeCoachingOutput, buildGeminiParts, createJsonLineStream } from '../src/lib/coaching-gemini';
import { getContextualizedPrompt } from '../src/data/coaching-system-prompt';
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';

// Exact synthetic production request/public delivery trace52584-64, 020120 R1 T9.
// Provider pre-normalization output was not captured; this is public delivery injection.
const observed = {
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
} as { history: CoachingChatMessage[]; latest: string; candidate: string };
const actuals: unknown[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => {
  const output = process.env.ACTI_ARTIFACT_CAUSE_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ scope: 'Exact saved 020120 R1 T9 public delivery; local regression only', providerOriginal: 'NOT_CAPTURED', actuals }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});
function assess(text: string) { return assessCoachingResponseQuality({ text, lastUserText: observed.latest, historyMessages: observed.history }); }
function verify(text: string, emptyFlags = false) {
  const q = assess(text);
  return ensureVerifiedCoachingResolution({ resolution: { text, usage: { total_tokens: 2 }, modelName: 'saved-public-delivery-fixture', provider: 'gemini', repairAttempted: false, repairAccepted: false, initialIssues: emptyFlags ? [] : q.issues, finalIssues: emptyFlags ? [] : q.issues }, lastUserText: observed.latest, historyMessages: observed.history, preserveUsage: true });
}
function expectGrounded(text: string) {
  expect(text).toContain('利用目的');
  expect(text).toContain('一枚目');
  expect(text).not.toMatch(/原因は|詰め込みすぎ|特徴や細かいメリット|という相談|原因を推測/);
  expect(assess(text).issues).toEqual([]);
}
describe('unseen artifact contents cannot become a diagnosed cause', () => {
  it('rejects the exact captured cause assertion before repair', () => {
    const quality = assess(observed.candidate); actuals.push({ stage: 'assess-captured', ...observed, quality });
    expect(quality.issues).toContain('ungrounded_task_assumption');
  });
  it('keeps the existing one-page purpose action grounded', () => {
    const final = buildFinalVerifiedQualityFallback(observed.latest, observed.history); actuals.push({ stage: 'existing-builder', ...observed, final, quality: assess(final) }); expectGrounded(final);
  });
  it.each(['minimal', 'legacy', 'observe'])('checks direct and normalized delivery in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const normalized = normalizeCoachingOutput(observed.candidate, observed.latest, observed.history);
    const direct = verify(observed.candidate); const normalizedVerified = verify(normalized);
    actuals.push({ stage: 'verified-two-paths', mode, ...observed, normalized, normalizedQuality: assess(normalized), direct, normalizedVerified });
    expectGrounded(normalizedVerified.text);
    if (mode === 'observe') { expect(direct.text).toBe(observed.candidate); expect(direct.initialIssues).toContain('ungrounded_task_assumption'); return; }
    expectGrounded(direct.text); expect(direct.finalIssues).toEqual([]); expect(direct.qualitySafetyHold).not.toBe(true);
  });
  it.each(['minimal', 'legacy', 'observe'])('does not trust empty upstream flags in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode); const result = verify(observed.candidate, true);
    actuals.push({ stage: 'empty-flags-delivery', mode, ...observed, result }); expect(result.usage).toEqual({ total_tokens: 2 });
    if (mode === 'observe') { expect(result.text).toBe(observed.candidate); expect(result.initialIssues).toContain('ungrounded_task_assumption'); return; }
    expectGrounded(result.text); expect(result.finalIssues).toEqual([]); expect(result.qualitySafetyHold).not.toBe(true);
  });
  it.each(['minimal', 'legacy', 'observe'])('checks complete public-candidate stream in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode); vi.stubGlobal('fetch', async () => { transport.fetch++; throw Error('NETWORK_FORBIDDEN'); });
    transport.raw = observed.candidate; const before = { ...transport }; const callbacks: Array<{ message: string }> = [];
    const reader = createJsonLineStream({ systemPrompt: getContextualizedPrompt('MGA-3'), historyMessages: observed.history, lastUserParts: buildGeminiParts(observed.latest, [], observed.history), onDone: async (_usage, value) => { callbacks.push(value); return {}; } }).getReader();
    const decoder = new TextDecoder(); let wire = ''; while (true) { const part = await reader.read(); if (part.done) break; wire += decoder.decode(part.value, { stream: true }); } wire += decoder.decode();
    const events = wire.trim().split('\n').map(line => JSON.parse(line)); const dones = events.filter(event => event.type === 'done'); const done = dones[0];
    const callDelta = { primary: transport.primary - before.primary, repair: transport.repair - before.repair };
    actuals.push({ stage: 'mock-fullstream', mode, ...observed, candidateOrigin: 'Saved public delivery, not provider original', callDelta, wire, events, done, callbacks, final: done?.message, forbidden: { provider: transport.provider, fetch: transport.fetch, alerts: transport.alerts } });
    expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1); expect(done.completionStatus).toBe('complete'); expect(done.finalizationStatus).toBe('complete');
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message); expect(callbacks[0].message).toBe(done.message);
    expect(transport.provider).toBe(0); expect(transport.fetch).toBe(0); expect(transport.alerts).toBe(0);
    if (mode === 'observe' && callDelta.primary > 0) { expect(done.message).toBe(observed.candidate); expect(done.qualityInitialIssues).toContain('ungrounded_task_assumption'); return; }
    expectGrounded(done.message); expect(done.qualityFinalIssues).toEqual([]); expect(done.qualitySafetyHold).not.toBe(true);
  });
});
