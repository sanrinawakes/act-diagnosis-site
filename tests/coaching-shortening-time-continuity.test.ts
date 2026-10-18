import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ raw: '', primary: 0, repair: 0, provider: 0, fetch: 0, alerts: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => { transport.primary++; return { stream: (async function* () { yield { text: () => transport.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }; },
  sendMessage: async () => { transport.repair++; return { response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }; },
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.provider++; throw Error('PROVIDER_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alerts++; throw Error('ALERT_FORBIDDEN'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, ensureVerifiedCoachingResolution, normalizeCoachingOutput, buildGeminiParts, createJsonLineStream } from '../src/lib/coaching-gemini';
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';

// Exact browser a2 request3 messages and public chunk/done from trace73546-browser-2.
// No diagnosisCode was supplied in that request. Local stream prompt below is a
// synthetic harness instruction, not a claim to reproduce its hidden server prompt.
// Provider pre-normalization candidate NOT_CAPTURED: saved PUBLIC final is injected.
const observed = {
  "traceId": "73546-browser-2",
  "requestMessages": [
    {
      "role": "user",
      "content": "E2E-1792206266322-ebbe72e3-a1。明日の一歩を一つ教えてください。"
    },
    {
      "role": "assistant",
      "content": "明日、終わらせたい用事を一つだけ紙に書いてください。"
    },
    {
      "role": "user",
      "content": "E2E-1792206266322-ebbe72e3-a2。短く答えてください。"
    }
  ],
  "history": [
    {
      "role": "user",
      "content": "E2E-1792206266322-ebbe72e3-a1。明日の一歩を一つ教えてください。"
    },
    {
      "role": "assistant",
      "content": "明日、終わらせたい用事を一つだけ紙に書いてください。"
    }
  ],
  "latest": "E2E-1792206266322-ebbe72e3-a2。短く答えてください。",
  "candidate": "今、次に終わらせる用事を一つだけ紙に書いてください。",
  "providerOriginal": "NOT_CAPTURED"
} as {
  traceId: string; requestMessages: CoachingChatMessage[]; history: CoachingChatMessage[];
  latest: string; candidate: string; providerOriginal: string;
};
const actuals: unknown[] = [];
const modes = ['minimal', 'legacy', 'observe'] as const;
function history() { return observed.history.map(message => ({ ...message })); }
function assess(text: string) { return assessCoachingResponseQuality({ text, lastUserText: observed.latest, historyMessages: history() }); }
function verify(text: string, emptyFlags = false) {
  const quality = assess(text);
  return ensureVerifiedCoachingResolution({ resolution: { text, usage: { total_tokens: 2 }, modelName: 'saved-browser-public-candidate-local-mock', provider: 'gemini',
    repairAttempted: false, repairAccepted: false, initialIssues: emptyFlags ? [] : quality.issues, finalIssues: emptyFlags ? [] : quality.issues },
    lastUserText: observed.latest, historyMessages: history(), preserveUsage: true });
}
function expectShortenedSameActionTomorrow(text: string) {
  expect(text).toMatch(/^明日(?:[、,]|は|の朝)/u);
  expect(text).not.toMatch(/今[、,]|今すぐ|今から|今日|本日/u); // adding 明日 before 今 is still wrong
  expect(text).toContain('用事'); expect(text).toMatch(/紙|メモ/u); expect(text).toMatch(/書/u);
  expect(text).toMatch(/一つ|ひとつ|1つ/u); expect(text).not.toMatch(/[？?]/u);
  expect(text).not.toMatch(/深呼吸|という相談ですね|まだ書かれていない原因|もう一度[^。]*送/u);
  expect(text.length).toBeLessThanOrEqual(80);
  expect(assess(text).issues).toEqual([]);
}
beforeEach(() => { vi.stubGlobal('fetch', async () => { transport.fetch++; throw Error('NETWORK_FORBIDDEN'); }); });
afterEach(() => {
  expect(transport.provider).toBe(0); expect(transport.fetch).toBe(0); expect(transport.alerts).toBe(0);
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
afterAll(() => {
  const output = process.env.ACTI_SHORTENING_TIME_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ scope: 'Exact browser a2 shortening-only followup,12 recorded stages plus one valid-previous-answer control', observed, providerOriginal: 'NOT_CAPTURED', actuals }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});

describe('shortening a prior action preserves its requested tomorrow execution date', () => {
  it('detects the exact public now action against the earlier user request', () => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', 'minimal'); const quality = assess(observed.candidate);
    actuals.push({ stage: 'assess-captured', ...observed, quality });
    expect(quality.issues).toContain('requested_time_mismatch');
  });
  it.each(modes)('records direct and normalized final delivery in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const initialQuality = assess(observed.candidate);
    const normalized = normalizeCoachingOutput(observed.candidate, observed.latest, history());
    const normalizedQuality = assess(normalized); const direct = verify(observed.candidate); const normalizedVerified = verify(normalized);
    actuals.push({ stage: 'normalized-two-paths', mode, ...observed, initialQuality, normalized, normalizedQuality, direct, normalizedVerified });
    expect(initialQuality.issues).toContain('requested_time_mismatch');
    if (mode === 'observe') {
      expect(direct.text).toBe(observed.candidate); expect(direct.initialIssues).toContain('requested_time_mismatch'); expect(direct.finalIssues).toEqual([]);
      expect(normalizedVerified.text).toBe(normalized); expect(normalizedVerified.initialIssues).toEqual(normalizedQuality.issues); expect(normalizedVerified.finalIssues).toEqual([]);
      if (normalizedQuality.issues.includes('requested_time_mismatch')) return; // known-bad intermediate is detection only
      expectShortenedSameActionTomorrow(normalized); return;
    }
    expectShortenedSameActionTomorrow(direct.text); expectShortenedSameActionTomorrow(normalizedVerified.text);
    expect(direct.finalIssues).toEqual([]); expect(normalizedVerified.finalIssues).toEqual([]);
    expect(direct.qualitySafetyHold).not.toBe(true); expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
  });
  it.each(modes)('rejects missing date even when upstream flags are empty in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode); const result = verify(observed.candidate, true);
    actuals.push({ stage: 'empty-flags-delivery', mode, ...observed, result }); expect(result.usage).toEqual({ total_tokens: 2 });
    if (mode === 'observe') { expect(result.text).toBe(observed.candidate); expect(result.initialIssues).toContain('requested_time_mismatch'); expect(result.finalIssues).toEqual([]); return; }
    expectShortenedSameActionTomorrow(result.text); expect(result.initialIssues).toContain('requested_time_mismatch');
    expect(result.finalIssues).toEqual([]); expect(result.qualitySafetyHold).not.toBe(true);
  });
  it.each(modes)('keeps stream, complete done and saved callback date aligned in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode); transport.raw = observed.candidate; const before = { ...transport }; const callbacks: Array<{ message: string }> = [];
    const reader = createJsonLineStream({ systemPrompt: 'Fixed synthetic saved-browser shortening-time regression.', historyMessages: history(),
      lastUserParts: buildGeminiParts(observed.latest, [], history()), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } }).getReader();
    const decoder = new TextDecoder(); let wire = '';
    while (true) { const next = await reader.read(); if (next.done) break; wire += decoder.decode(next.value, { stream: true }); } wire += decoder.decode();
    const events = wire.trim().split('\n').map(line => JSON.parse(line)); const dones = events.filter(event => event.type === 'done'); const done = dones[0];
    const callDelta = { primary: transport.primary - before.primary, repair: transport.repair - before.repair, provider: transport.provider - before.provider, fetch: transport.fetch - before.fetch, alerts: transport.alerts - before.alerts };
    actuals.push({ stage: 'mock-fullstream', mode, ...observed, configuredCandidateConsumed: callDelta.primary > 0, callDelta, wire, events, done, callbacks, final: done?.message });
    expect(callDelta.primary).toBeLessThanOrEqual(1); expect(callDelta.repair).toBeLessThanOrEqual(1);
    expect(callDelta.provider).toBe(0); expect(callDelta.fetch).toBe(0); expect(callDelta.alerts).toBe(0);
    expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1); expect(done.completionStatus).toBe('complete'); expect(done.finalizationStatus).toBe('complete');
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message); expect(callbacks[0].message).toBe(done.message);
    if (callDelta.primary > 0) expect(done.qualityInitialIssues).toContain('requested_time_mismatch'); else expect(callDelta.repair).toBe(0);
    if (mode === 'observe' && callDelta.primary > 0) { expect(done.message).toBe(observed.candidate); expect(done.qualityFinalIssues).toEqual([]); return; }
    expectShortenedSameActionTomorrow(done.message); expect(done.qualityFinalIssues).toEqual([]); expect(done.qualitySafetyHold).not.toBe(true);
  });
  it('allows the prior valid action when shortening does not need a new action', () => {
    const text = observed.history[1].content;
    expect(assess(text).issues).toEqual([]);
    expect(normalizeCoachingOutput(text, observed.latest, history())).toBe(text);
  });
  it('does not reuse an older different action as the requested shortening', () => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', 'legacy');
    const oldAction = '明日、深呼吸を一回だけしてください。';
    const messages: CoachingChatMessage[] = [
      { role: 'user', content: '明日の行動を一つ教えてください。' },
      { role: 'assistant', content: oldAction },
      ...history(),
    ];
    const quality = assessCoachingResponseQuality({ text: oldAction, lastUserText: observed.latest, historyMessages: messages });
    const final = ensureVerifiedCoachingResolution({ resolution: { text: oldAction, usage: {}, modelName: 'local-control',
      repairAttempted: false, repairAccepted: false, initialIssues: quality.issues, finalIssues: quality.issues },
      lastUserText: observed.latest, historyMessages: messages });
    actuals.push({ stage: 'older-different-action-control', history: messages, latest: observed.latest, candidate: oldAction, quality, final });
    expect(quality.issues).toContain('repeated_closing_move');
    expect(final.text).not.toBe(oldAction);
    expectShortenedSameActionTomorrow(final.text);
  });
  it('keeps the existing local builder on the same requested day and action', () => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', 'minimal'); const final = buildFinalVerifiedQualityFallback(observed.latest, history());
    actuals.push({ stage: 'existing-builder', ...observed, final, quality: assess(final) }); expectShortenedSameActionTomorrow(final);
  });
});
