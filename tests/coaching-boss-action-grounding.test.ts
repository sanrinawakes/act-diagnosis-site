// Observed synthetic public deliveries replayed with a fixed offline SDK; not provider-original raw.
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ raw: '', external: 0, alerts: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: () => ({ startChat: () => ({
  sendMessageStream: async () => ({ stream: (async function* () { yield { text: () => state.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }),
  sendMessage: async () => ({ response: { text: () => state.raw, candidates: [{ finishReason: 'STOP' }] } }),
}) }) }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { state.external++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { state.alerts++; throw new Error('ALERT_FORBIDDEN'); } }));
import { assessCoachingResponseQuality, buildGeminiParts, createJsonLineStream, buildIncompleteGenerationRecoveryResponse, type CoachingChatMessage } from '../src/lib/coaching-gemini';
import { getContextualizedPrompt } from '../src/data/coaching-system-prompt';

export const observedBossActionCases = [
  {
    "name": "observed-smoke-normal-2",
    "diagnosis": "PMA-2",
    "history": [
      {
        "role": "user",
        "content": "仕事のことで少し落ち込んでいます。短く整理を手伝ってください。"
      },
      {
        "role": "assistant",
        "content": "仕事のことで少し落ち込んでいるのですね。原因を決めつけず、まず落ち込むきっかけになった出来事を一つ確認します。\n\n仕事で、今いちばん気になっている出来事は何ですか？"
      }
    ],
    "latest": "上司に否定されたように感じて、次の一言が怖いです。",
    "candidate": "上司に否定されたように感じ、次に何を言ってもまた否定されるのではないかと、言葉を出す前に止まっているのですね。今必要なのは、上司の意図を推測することより、どの指摘から直せばよいかを具体的に確認することです。\n\n次に話す時は、「前回のご指摘について、最初に見直す点を一つだけ挙げてもらえますか」と伝えてください。",
    "expectedIssue": "context_mismatch",
    "defects": [
      "actual-stopped-speaking-not-reported",
      "universal-renewed-denial-not-reported",
      "prior-specific-correction-not-reported"
    ]
  },
  {
    "name": "observed-parallel-burst-1",
    "diagnosis": "MGA-3",
    "history": [],
    "latest": "同時接続テスト1です。明日の朝に始める行動を一つだけ、質問なしで答えてください。",
    "candidate": "明日の朝一番に、今日残した作業のリストを1つ確認してください。",
    "expectedIssue": "ungrounded_task_assumption",
    "defects": [
      "leftover-work-and-existing-list-not-reported"
    ]
  },
  {
    "name": "observed-topic-switch-home-turn-2",
    "diagnosis": "MGE-3",
    "history": [
      {
        "role": "user",
        "content": "仕事の締切が重なり、優先順位を決めたいです。"
      },
      {
        "role": "assistant",
        "content": "仕事の締切が重なり、どれから進めるかを決めたいのですね。期限の早さだけでなく、作業に必要な時間や、他の人の作業を止めているかも判断材料になります。まず仕事ごとに締切と所要時間を並べ、期限内に収まらないものがあれば、順番を工夫するだけでなく日程や分担を相談する対象として分けてください。"
      }
    ],
    "latest": "仕事の整理はできました。今度は家での相談です。",
    "candidate": "仕事の整理はいったん区切れたのですね。ここからは家の話に切り替えます。家の相談では、相手の気持ちを広く考える前に、今止まっている出来事を一つに絞った方が次の対応を決めやすくなります。\n\n家で今いちばん止まっている出来事を、一つだけ具体的に教えてください。",
    "expectedIssue": "context_mismatch",
    "defects": [
      "stalled-home-event-not-reported"
    ]
  },
  {
    "name": "observed-smoke-normal-3-adjacent",
    "diagnosis": "PMA-2",
    "history": [
      {
        "role": "user",
        "content": "仕事のことで少し落ち込んでいます。短く整理を手伝ってください。"
      },
      {
        "role": "assistant",
        "content": "仕事のことで少し落ち込んでいるのですね。原因を決めつけず、まず落ち込むきっかけになった出来事を一つ確認します。\n\n仕事で、今いちばん気になっている出来事は何ですか？"
      },
      {
        "role": "user",
        "content": "上司に否定されたように感じて、次の一言が怖いです。"
      },
      {
        "role": "assistant",
        "content": "上司に否定されたように感じ、次に何を言ってもまた否定されるのではないかと、言葉を出す前に止まっているのですね。今必要なのは、上司の意図を推測することより、どの指摘から直せばよいかを具体的に確認することです。\n\n次に話す時は、「前回のご指摘について、最初に見直す点を一つだけ挙げてもらえますか」と伝えてください。"
      }
    ],
    "latest": "では、明日まず何をすればいいか一つだけ教えてください。",
    "candidate": "明日の朝、上司に「前回のご指摘について、最初に見直す点を一つだけ挙げてもらえますか」と確認してください。",
    "expectedIssue": "context_mismatch"
  }
] as const;
const fixture = { cases: observedBossActionCases, existingPositiveControls: [
  {
    "name": "reported-fear-neutral-question",
    "history": [
      {
        "role": "user",
        "content": "仕事のことで少し落ち込んでいます。短く整理を手伝ってください。"
      },
      {
        "role": "assistant",
        "content": "仕事のことで少し落ち込んでいるのですね。原因を決めつけず、まず落ち込むきっかけになった出来事を一つ確認します。\n\n仕事で、今いちばん気になっている出来事は何ですか？"
      }
    ],
    "latest": "上司に否定されたように感じて、次の一言が怖いです。",
    "candidate": "上司に否定されたように感じて、次の一言が怖いんですね。\n\n次にその上司へ話す時、いちばん避けたいことは何ですか？",
    "expect": "no-added-behavior-or-correction",
    "source": "src/lib/coaching-gemini.ts rewriteContextualClosingQuestion existing literal"
  },
  {
    "name": "concrete-paper-one-action",
    "history": [],
    "latest": "同時接続テスト1です。明日の朝に始める行動を一つだけ、質問なしで答えてください。",
    "candidate": "明日の朝、終わらせたい用事を一つだけ紙に書いてください。",
    "expect": "one-specific-action-without-existing-list",
    "source": "existing production positive and permanent single-action tests"
  }
] };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('finite three observed boss, task-artifact and home-topic regressions before edits', () => {
  for (const item of fixture.cases) {
    it('detects the existing observation: '+item.name, () => {
      expect(assessCoachingResponseQuality({ text: item.candidate, lastUserText: item.latest, historyMessages: [...item.history] }).issues).toContain(item.expectedIssue);
    });
    for (const mode of ['minimal', 'legacy', 'observe']) it('detects or recovers '+item.name+' in '+mode, async () => {
      vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
      vi.stubGlobal('fetch', async () => { state.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
      state.raw = item.candidate; const history = [...item.history] as CoachingChatMessage[]; const callbacks: { message?: string }[] = [];
      const stream = createJsonLineStream({ systemPrompt: getContextualizedPrompt(item.diagnosis), historyMessages: history,
        lastUserParts: buildGeminiParts(item.latest, [], history), onDone: async (_usage, completion) => { callbacks.push(completion); return {}; } });
      const reader = stream.getReader(); const decoder = new TextDecoder(); let raw = '';
      while (true) { const chunk = await reader.read(); if (chunk.done) break; raw += decoder.decode(chunk.value, { stream: true }); }
      raw += decoder.decode(); const events = raw.trim().split('\n').map(line => JSON.parse(line));
      const dones = events.filter(event => event.type === 'done'); expect(dones).toHaveLength(1); expect(callbacks).toHaveLength(1);
      const done = dones[0]; const publicText = events.filter(event => event.type === 'chunk').map(event => event.text).join('');
      expect(publicText).toBe(done.message); expect(callbacks[0].message).toBe(done.message);
      if (mode === 'observe') { expect(done.qualityInitialIssues).toContain(item.expectedIssue); expect(done.message).toBe(item.candidate); }
      else {
        expect(done.message).not.toBe(item.candidate); expect(done.qualityFinalIssues).toEqual([]);
        if (item.name === 'observed-smoke-normal-2' || item.name === 'observed-smoke-normal-3-adjacent') { expect(done.message).toMatch(/上司|次の一言/); expect(done.message).not.toMatch(/何を言ってもまた|言葉を出す前に止ま|前回のご指摘|どの指摘/); }
        if (item.name === 'observed-parallel-burst-1') { expect(done.message).toMatch(/紙|書/); expect(done.message).not.toMatch(/今日残した|やり残|未完了|残っている作業/); }
        if (item.name === 'observed-topic-switch-home-turn-2') { expect(done.message).toMatch(/家/); expect(done.message).not.toMatch(/止まっている出来事|相手の気持ち/); }
      }
      expect(state.external).toBe(0); expect(state.alerts).toBe(0); expect(state.fetch).toBe(0);
    });
  }
  it.each(fixture.existingPositiveControls)('preserves the existing positive: $name', (item) => {
    const issues = assessCoachingResponseQuality({ text: item.candidate, lastUserText: item.latest, historyMessages: item.history as CoachingChatMessage[] }).issues;
    expect(issues).not.toContain('context_mismatch');
    expect(issues).not.toContain('ungrounded_task_assumption');
  });
});

import { containsUngroundedTaskAssumption, containsUnsupportedSituationPremise } from '../src/lib/coaching-action-language.mjs';
describe('existing user grounding stays eligible', () => {
  it('allows the observed task-list wording when that list is actually supplied by the user', () => {
    const text = '明日の朝一番に、今日残した作業のリストを1つ確認してください。';
    expect(containsUngroundedTaskAssumption(text, ['今日残した作業のリストを作りました。'])).toBe(false);
  });
  it('allows a specific correction only when the user supplies it', () => {
    expect(containsUnsupportedSituationPremise('前回のご指摘について確認してください。', ['上司から具体的な指摘を受けました。'])).toBe(false);
  });
});

describe('the same short-fear recovery uses only supplied facts', () => {
  it('keeps the existing boss facts but does not add them to fear alone', () => {
    expect(buildIncompleteGenerationRecoveryResponse('上司に否定されたように感じて、次の一言が怖いです。')).toContain('上司に否定されたように感じて');
    expect(buildIncompleteGenerationRecoveryResponse('次の一言が怖いです。')).toBe('次の一言が怖いんですね。\n\n次に話す時、いちばん避けたいことは何ですか？');
  });
});

describe('the same bounded evidence requires direct affirmation', () => {
  const list = '明日の朝一番に、今日残した作業のリストを1つ確認してください。';
  const correction = '前回のご指摘について確認してください。';
  it('does not use explicit task-list denial or AI quotation as a fact', () => {
    for (const text of ['今日残した作業のリストはありません。', 'AIが「今日残した作業のリストを作りました」と言いました。']) {
      expect(containsUngroundedTaskAssumption(list,[text])).toBe(true);
    }
    expect(containsUngroundedTaskAssumption(list,['今日残した作業のリストを作りました。','今日残した作業のリストはありません。'])).toBe(true);
  });
  it('does not use a negated or quoted correction as an actual correction', () => {
    for (const text of ['具体的な指摘は受けていません。', 'AIが「具体的な指摘を受けました」と言いました。']) {
      expect(containsUnsupportedSituationPremise(correction,[text])).toBe(true);
    }
  });
  it('keeps reported inability to speak as an affirmative state', () => {
    expect(containsUnsupportedSituationPremise('言葉を出す前に止まっているのですね。',['言葉が出ないです。'])).toBe(false);
  });
  it('does not infer boss denial from its negation or quotation', () => {
    for (const text of ['上司に否定されていません。次の一言が怖いです。','上司は同僚を否定しました。次の一言が怖いです。','AIが「上司に否定された」と言いました。次の一言が怖いです。']) {
      expect(buildIncompleteGenerationRecoveryResponse(text)).not.toMatch(/上司|否定/);
    }
  });
});

describe('the same four situation premises reject their negated or quoted evidence', () => {
  it.each([
    ['言葉を出す前に止まっているのですね。','言葉を出す前に止まっていません。'],
    ['家で今いちばん止まっている出来事は何ですか？','今止まっている出来事はありません。'],
    ['次に何を言ってもまた否定されると考えているのですね。','また否定されるとは言っていません。'],
    ['前回のご指摘について確認してください。','具体的な指摘は受けていません。'],
  ])('requires affirmative evidence for %s', (output, denied) => {
    expect(containsUnsupportedSituationPremise(output,[denied])).toBe(true);
    expect(containsUnsupportedSituationPremise(output,[`AIが「${output}」と言いました。`])).toBe(true);
  });
  it('does not transfer a third-party list or correction to the user', () => {
    expect(containsUngroundedTaskAssumption('今日残した作業のリストを確認してください。',['同僚は今日残した作業のリストを作りました。'])).toBe(true);
    expect(containsUnsupportedSituationPremise('前回のご指摘について確認してください。',['同僚は具体的な指摘を受けました。'])).toBe(true);
  });
});
