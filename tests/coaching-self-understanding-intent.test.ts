import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

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

import { assessCoachingResponseQuality, ensureVerifiedCoachingResolution } from '../src/lib/coaching-gemini';

// Anonymous fixtures, not customer wording. The fixed descriptive candidate is
// an example for a known synthetic PGA-4 context. This does not infer a user's
// diagnosis, resolve hidden system context, or generate missing personal traits.
const candidate = 'PGA-4という診断では、Pは外向型、Gは現実型、Aは論理型を表します。この分類は、その人がいつでも同じ行動を取るという断定ではありません。日常の行動を理解するときの参考として、診断の説明と実際の経験の両方を照らし合わせるためのものです。';
const actuals: Array<Record<string, unknown>> = [];
vi.stubGlobal('fetch', async () => { forbidden.fetch++; throw new Error('FETCH_FORBIDDEN'); });
afterAll(() => {
  const output = process.env.ACTI_SELF_UNDERSTANDING_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({
    scope: 'Pure public assessor only; explanatory versus concrete-action intent',
    candidateOrigin: 'LOCAL_SYNTHETIC_DESCRIPTIVE_FIXTURE_NOT_PROVIDER_RAW',
    syntheticReferenceContext: { code: 'PGA-4', suppliedToAssessor: false },
    actuals,
    forbidden,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  vi.unstubAllGlobals();
  expect(forbidden).toEqual({ sdk: 0, provider: 0, alerts: 0, fetch: 0 });
});

describe('type explanation is distinct from a concrete action request', () => {
  it.each([
    '自分のタイプについて、日常の行動の傾向を説明してください。',
    '私のタイプは、普段どんな行動を取りやすいですか。',
    'PGA-4の普段の行動傾向について知りたいです。',
    '自分のタイプの特徴を教えてください。',
  ])('does not require an imperative action in a descriptive explanation: %s', (latest) => {
    const quality = assessCoachingResponseQuality({ text: candidate, lastUserText: latest, historyMessages: [] });
    const delivery = ensureVerifiedCoachingResolution({
      resolution: {
        text: candidate, usage: {}, provider: 'local', modelName: 'synthetic-type-description',
        repairAttempted: false, repairAccepted: false,
        initialIssues: quality.issues, finalIssues: quality.issues,
      },
      lastUserText: latest, historyMessages: [],
    });
    actuals.push({ kind: 'explanatory', latest, history: [], candidate, quality, delivery });
    expect(quality.issues).not.toContain('vague_action_target');
    expect(quality.issues).toEqual([]);
    expect(delivery.text).toBe(candidate);
    expect(delivery.finalIssues).toEqual([]);
  });

  it.each([
    '具体的な行動を一つ提案してください。',
    '明日どう行動すればよいか、一つ提案してください。',
    'タイプの傾向を踏まえて、明日できる行動を一つ提案してください。',
  ])('still rejects description alone when an actual action is requested: %s', (latest) => {
    const quality = assessCoachingResponseQuality({ text: candidate, lastUserText: latest, historyMessages: [] });
    actuals.push({ kind: 'action-required-control', latest, history: [], candidate, quality });
    expect(quality.issues).toContain('vague_action_target');
  });
});
