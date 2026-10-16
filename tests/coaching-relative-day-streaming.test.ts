import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ raw: '', external: 0, alerts: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => ({
    stream: (async function* () { yield { text: () => transport.raw }; })(),
    response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }),
  }),
  sendMessage: async () => ({ response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }),
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.external++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alerts++; throw new Error('ALERT_FORBIDDEN'); } }));

import { assessCoachingResponseQuality, buildGeminiParts, createJsonLineStream } from '../src/lib/coaching-gemini';
import { containsAmbiguousFutureActionDayReference } from '../src/lib/coaching-action-language.mjs';
import { getContextualizedPrompt } from '../src/data/coaching-system-prompt';

const latest = '同時接続テスト5です。明日の朝に始める行動を一つだけ、質問なしで答えてください。';
// Injected SDK fixture copied from actual public delivery, not recovered provider-original text.
const observed = '明日の朝起きたら、まず今日行う作業を1つ紙に書き出してください。';
const replayed: { mode: string; input: string; injectedCandidate: string; final: string; initialIssues: string[]; finalIssues: string[] }[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => {
  const output = process.env.ACTI_RELATIVE_DAY_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ network: 0, cases: replayed }, null, 2), { flag: 'wx', mode: 0o600 });
});

async function replay(raw: string, mode: string) {
  vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
  vi.stubGlobal('fetch', async () => { transport.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
  transport.raw = raw;
  const callbacks: { message?: string }[] = [];
  const stream = createJsonLineStream({
    systemPrompt: getContextualizedPrompt('MGA-3'), historyMessages: [],
    lastUserParts: buildGeminiParts(latest, [], []),
    onDone: async (_usage, completion) => { callbacks.push(completion); return {}; },
  });
  const reader = stream.getReader(); const decoder = new TextDecoder(); let body = '';
  while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value, { stream: true }); }
  body += decoder.decode();
  const events = body.trim().split('\n').map((line) => JSON.parse(line));
  const dones = events.filter((event) => event.type === 'done');
  expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
  const done = dones[0];
  expect(events.filter((event) => event.type === 'chunk').map((event) => event.text).join('')).toBe(done.message);
  expect(callbacks[0].message).toBe(done.message);
  replayed.push({ mode, input: latest, injectedCandidate: raw, final: done.message, initialIssues: done.qualityInitialIssues, finalIssues: done.qualityFinalIssues });
  expect(transport.external).toBe(0); expect(transport.alerts).toBe(0); expect(transport.fetch).toBe(0);
  return done;
}

describe('actual relative-day defect through the full offline stream', () => {
  it.each(['minimal', 'legacy'].flatMap((mode) => [
    [mode, observed],
    [mode, '明日の朝起きたら、まず今日の作業を1つ紙に書き出してください。'],
    [mode, '明日の朝、本日の仕事を一つメモしてください。'],
  ]))('recovers the observed or adjacent target-day fixture in %s: %s', async (mode, candidate) => {
    const done = await replay(candidate, mode);
    expect(done.message).not.toBe(candidate);
    expect(done.message).toContain('明日の朝');
    expect(containsAmbiguousFutureActionDayReference(done.message, latest)).toBe(false);
    expect(done.qualityFinalIssues).toEqual([]);
    expect(assessCoachingResponseQuality({ text: done.message, lastUserText: latest, historyMessages: [] }).issues).toEqual([]);
  });

  it('detects the exact defect without rewriting in observe mode', async () => {
    const done = await replay(observed, 'observe');
    expect(done.message).toBe(observed);
    expect(done.qualityInitialIssues).toContain('requested_time_mismatch');
  });

  it.each(['minimal', 'legacy'])('preserves the explicit execution-day positive in %s', async (mode) => {
    const safe = '明日の朝、その日に行う作業を一つ紙に書いてください。';
    const done = await replay(safe, mode);
    expect(done.message).toBe(safe);
    expect(done.qualityFinalIssues).toEqual([]);
  });
});
