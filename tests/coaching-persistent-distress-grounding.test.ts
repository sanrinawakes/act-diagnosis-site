import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reuse the existing artifact-cause/emotion offline SDK mock; no provider call.
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

// Exact synthetic ab234 R2 trace61936-70, short-reply-continuation-1.
// Native rawMessage, final, chunk concatenation and done.message are identical.
// Provider pre-normalization candidate was NOT_CAPTURED: injection uses the saved PUBLIC delivery.
const observed = {
  "traceId": "61936-70",
  "diagnosisCode": "MME-3",
  "history": [],
  "latest": "友人に断りたい予定があるのに、返事を先延ばしにしています。",
  "candidate": "断りたい予定があるのに返事を先延ばしにしていると、ずっと頭のどこかで気になって過ごしづらいですよね。\n\n断った後の友人との関係が気になって、返事を送るのが難しくなっていますか？"
} as { traceId: string; diagnosisCode: string; history: CoachingChatMessage[]; latest: string; candidate: string };
const actuals: unknown[] = [];
const modes = ['minimal', 'legacy', 'observe'] as const;
const observedClaim = /ずっと頭のどこかで気になって|過ごしづらいですよね/u;
function history() { return observed.history.map(message => ({ ...message })); }
function assess(text: string) { return assessCoachingResponseQuality({ text, lastUserText: observed.latest, historyMessages: history() }); }
function verify(text: string, emptyFlags = false) {
  const quality = assess(text);
  return ensureVerifiedCoachingResolution({ resolution: {
    text, usage: { total_tokens: 2 }, modelName: 'saved-public-delivery-local-fixture', provider: 'gemini',
    repairAttempted: false, repairAccepted: false,
    initialIssues: emptyFlags ? [] : quality.issues, finalIssues: emptyFlags ? [] : quality.issues,
  }, lastUserText: observed.latest, historyMessages: history(), preserveUsage: true });
}
function expectGrounded(text: string) {
  // Retain the actual topic, not a new generic task. No exact replacement wording required.
  expect(text).toMatch(/友人|友達/u); expect(text).toMatch(/断/u); expect(text).toContain('返事');
  expect(text).not.toMatch(observedClaim);
  // Delaying a reply is not evidence that writing was attempted and then
  // became impossible because of a particular cognitive obstacle.
  expect(text).not.toMatch(/返事を書こうとした時|送れなくな|返事を止めてしまう/u);
  expect(text).not.toMatch(/という相談ですね|まだ書かれていない原因を推測/u);
  expect(assess(text).issues).toEqual([]);
}
beforeEach(() => {
  vi.stubGlobal('fetch', async () => { transport.fetch++; throw Error('NETWORK_FORBIDDEN'); });
});
afterEach(() => {
  expect(transport.provider).toBe(0); expect(transport.fetch).toBe(0); expect(transport.alerts).toBe(0);
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
afterAll(() => {
  const output = process.env.ACTI_PERSISTENT_DISTRESS_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ scope: 'Exact saved ab234 R2 trace61936-70; 11 finite local integration stages', providerOriginal: 'NOT_CAPTURED', candidateOrigin: 'saved-public-delivery', observed, actuals }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});

describe('reported delay is not evidence of persistent preoccupation or life difficulty', () => {
  it('detects the exact public assertion', () => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', 'minimal');
    const quality = assess(observed.candidate);
    actuals.push({ stage: 'assessor', ...observed, quality });
    expect(quality.issues).toContain('context_mismatch');
  });

  it.each(modes)('records normalized intermediate plus both final verification paths in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const initialQuality = assess(observed.candidate);
    const normalized = normalizeCoachingOutput(observed.candidate, observed.latest, history());
    const normalizedQuality = assess(normalized);
    const direct = verify(observed.candidate); const normalizedVerified = verify(normalized);
    actuals.push({ stage: 'normalized-two-paths', mode, ...observed, initialQuality, normalized, normalizedQuality, direct, normalizedVerified });
    expect(initialQuality.issues).toContain('context_mismatch');
    if (mode === 'observe') {
      expect(direct.text).toBe(observed.candidate); expect(direct.initialIssues).toContain('context_mismatch');
      expect(direct.finalIssues).toEqual([]); // detection-only contract, not repaired semantic success
      // Observe reports the independently assessed normalized result without
      // repairing it. A shorter remaining question may have too_short: retain
      // that evidence rather than misreporting semantic success in this mode.
      expect(normalizedVerified.text).toBe(normalized);
      expect(normalizedVerified.initialIssues).toEqual(normalizedQuality.issues);
      expect(normalizedVerified.finalIssues).toEqual([]);
      if (observedClaim.test(normalized)) expect(normalizedQuality.issues).toContain('context_mismatch');
      return;
    }
    expectGrounded(direct.text); expectGrounded(normalizedVerified.text);
    expect(direct.finalIssues).toEqual([]); expect(normalizedVerified.finalIssues).toEqual([]);
    expect(direct.qualitySafetyHold).not.toBe(true); expect(normalizedVerified.qualitySafetyHold).not.toBe(true);
  });

  it.each(modes)('does not treat empty upstream flags as evidence in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const result = verify(observed.candidate, true);
    actuals.push({ stage: 'empty-flags-delivery', mode, ...observed, result });
    expect(result.usage).toEqual({ total_tokens: 2 });
    if (mode === 'observe') {
      expect(result.text).toBe(observed.candidate); expect(result.initialIssues).toContain('context_mismatch');
      expect(result.finalIssues).toEqual([]); return; // bad output is retained only as an observed defect
    }
    expectGrounded(result.text); expect(result.initialIssues).toContain('context_mismatch');
    expect(result.finalIssues).toEqual([]); expect(result.qualitySafetyHold).not.toBe(true);
  });

  it.each(modes)('records the complete injected-public-candidate stream in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    transport.raw = observed.candidate; const before = { ...transport }; const callbacks: Array<{ message: string }> = [];
    const reader = createJsonLineStream({ systemPrompt: getContextualizedPrompt(observed.diagnosisCode), historyMessages: history(),
      lastUserParts: buildGeminiParts(observed.latest, [], history()), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } }).getReader();
    const decoder = new TextDecoder(); let wire = '';
    while (true) { const part = await reader.read(); if (part.done) break; wire += decoder.decode(part.value, { stream: true }); }
    wire += decoder.decode();
    const events = wire.trim().split('\n').map(line => JSON.parse(line)); const dones = events.filter(event => event.type === 'done'); const done = dones[0];
    const callDelta = { primary: transport.primary - before.primary, repair: transport.repair - before.repair, provider: transport.provider - before.provider, fetch: transport.fetch - before.fetch, alerts: transport.alerts - before.alerts };
    actuals.push({ stage: 'mock-fullstream', mode, ...observed, candidateOrigin: 'saved-public-delivery; provider original NOT_CAPTURED', configuredCandidateConsumed: callDelta.primary > 0, callDelta, wire, events, done, callbacks, final: done?.message });
    expect(callDelta.primary).toBeLessThanOrEqual(1); expect(callDelta.repair).toBeLessThanOrEqual(1);
    expect(callDelta.provider).toBe(0); expect(callDelta.fetch).toBe(0); expect(callDelta.alerts).toBe(0);
    expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
    expect(done.completionStatus).toBe('complete'); expect(done.finalizationStatus).toBe('complete');
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done.message);
    expect(callbacks[0].message).toBe(done.message);
    if (callDelta.primary > 0) expect(done.qualityInitialIssues).toContain('context_mismatch');
    else expect(callDelta.repair).toBe(0); // immediate local path: explicitly recorded, not called a tested injection
    if (mode === 'observe' && callDelta.primary > 0) {
      expect(done.message).toBe(observed.candidate); expect(done.qualityFinalIssues).toEqual([]); return;
    }
    expectGrounded(done.message); expect(done.qualityFinalIssues).toEqual([]); expect(done.qualitySafetyHold).not.toBe(true);
  });

  it('keeps the existing local builder grounded in the actual user report', () => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', 'minimal');
    const final = buildFinalVerifiedQualityFallback(observed.latest, history()); const quality = assess(final);
    actuals.push({ stage: 'existing-builder', ...observed, final, quality }); expectGrounded(final);
  });
});
