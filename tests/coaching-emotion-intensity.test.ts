import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ raw: '', repairs: 0, instructions: [] as string[] }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => ({ getGenerativeModel: (options: { systemInstruction: string }) => {
  transport.instructions.push(options.systemInstruction);
  return { startChat: () => ({
  sendMessageStream: async () => ({ stream: (async function* () { yield { text: () => transport.raw }; })(), response: Promise.resolve({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }) }),
  sendMessage: async () => { transport.repairs++; return { response: { text: () => transport.raw, candidates: [{ finishReason: 'STOP' }] } }; },
}) }; } }) }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { throw new Error('NETWORK_DISABLED'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { throw new Error('ALERT_DISABLED'); } }));

import { assessCoachingResponseQuality, buildGeminiParts, createJsonLineStream, normalizeCoachingOutput, type CoachingChatMessage } from '../src/lib/coaching-gemini';
import { containsUnsupportedEmotionIntensity, removeUnsupportedEmotionIntensity } from '../src/lib/coaching-emotion-language.mjs';

// Public delivery from the synthetic standard scenario, not provider-original text.
export const intensityLatest = '条件の一覧より、自分がなぜ迷うのかを話したいです。';
export const intensityHistory: CoachingChatMessage[] = [
  { role: 'user', content: '新しい役割を引き受けるか迷っています。' },
  { role: 'assistant', content: '新しい役割を引き受けるか迷っているのですね。まだ、条件について確認したいのか、自分の気持ちについて話したいのかは分かりません。どちらも判断の材料になるので、今気になっている点から考えられます。\n\nその役割を引き受けるかどうかで、いちばん迷っているのはどの点ですか？' },
];
export const intensityCandidate = '自分の気持ちや理由に目を向けたいのですね。条件の数値や項目よりも、心がかき乱される理由を理解することが、あなたにとって納得のいく判断につながります。\n\nその新しい役割の話を聞いたとき、最初に頭に浮かんだのはどんな考えでしたか？';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('emotion intensity grounded in the user report', () => {
  it.each([
    '心がかき乱される理由を理解することが判断につながります。',
    'あなたは激しく動揺しているのですね。',
    '気持ちが大きく乱れる理由は何ですか？',
    '心がかき乱されるのはなぜですか？',
    '上司に「心がかき乱されています」と伝えてください。',
    '心が乱れているとは断定しませんが、激しく動揺していますね。',
  ])('rejects a new assertion, presupposing question or outbound quote: %s', text => {
    expect(containsUnsupportedEmotionIntensity(text, [intensityHistory[0].content, intensityLatest])).toBe(true);
  });

  it.each([
    '新しい役割のことを考えると、心がかき乱されていますか？',
    '心が乱れますか？',
    'もし心がかき乱されることがあれば、そのときの考えを聞かせてください。',
    '仮に激しく動揺した場合は、その場を離れることもできます。',
    '心がかき乱されているとは決めつけません。',
    '心がかき乱されているわけではありません。',
    '心が乱れていません。',
    '心が乱れていないので、条件だけ確認したいです。',
    '心が乱れません。',
    '自分がなぜ迷うのかを話したいのですね。新しい役割について、最初に何が頭に浮かびましたか？',
  ])('does not classify a genuine question, hypothetical or negation as a new state: %s', text => {
    expect(containsUnsupportedEmotionIntensity(text, [intensityLatest])).toBe(false);
    expect(removeUnsupportedEmotionIntensity(text, [intensityLatest])).toBe(text);
  });

  it.each(['心がかき乱されています。', '心が掻き乱されています。', '新しい役割のことで、心がかき乱されています。'])('retains an explicitly stated current feeling: %s', user => {
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', [user])).toBe(false);
  });

  it.each([
    '心がかき乱されていません。',
    '心がかき乱されているとは言っていません。',
    '心がかき乱されているわけではありません。',
    '心がかき乱されていますか？',
    'もし心がかき乱されることがあれば、相談できますか？',
    '上司は心がかき乱されているそうです。',
    '上司から「心がかき乱されている」と言われました。',
  ])('does not use negation, questions or someone else as personal evidence: %s', user => {
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', [user])).toBe(true);
  });

  it('uses the latest explicit correction instead of an old affirmation', () => {
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', ['心がかき乱されています。', '心がかき乱されていません。'])).toBe(true);
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', ['心がかき乱されていません。', '今は心がかき乱されています。'])).toBe(false);
  });

  it('keeps the explicit personal subject after an event involving someone else', () => {
    expect(containsUnsupportedEmotionIntensity('その場面では心が乱れるのですね。', ['妻が話し始めると、私は心が乱れてしまいます。'])).toBe(false);
  });

  it.each(['Aさんは心がかき乱されているそうです。', '息子の心がかき乱されています。'])('does not copy an explicitly named person or owner into the user: %s', user => {
    expect(containsUnsupportedEmotionIntensity('あなたは心がかき乱されているのですね。', [user])).toBe(true);
  });

  it('does not copy an explicit third-party subject without a name or possessive', () => {
    expect(containsUnsupportedEmotionIntensity('あなたは心がかき乱されているのですね。', ['息子は心がかき乱されています。'])).toBe(true);
  });

  it('does not reuse personal support for a different output subject', () => {
    expect(containsUnsupportedEmotionIntensity('Aさんは心がかき乱されているのですね。', ['私は心がかき乱されています。'])).toBe(true);
  });

  it('resolves reflexive ownership to the explicit third-party subject', () => {
    expect(containsUnsupportedEmotionIntensity('あなたは心がかき乱されているのですね。', ['Aさんは自分の心がかき乱されているそうです。'])).toBe(true);
  });

  it('treats the same named actor and heart owner as one third-party identity', () => {
    expect(containsUnsupportedEmotionIntensity('Aさんの心がかき乱されているのですね。', ['Aさんは心がかき乱されているそうです。'])).toBe(false);
    expect(containsUnsupportedEmotionIntensity('Aさんは心がかき乱されているのですね。', ['Aさんの心がかき乱されています。'])).toBe(false);
  });

  it.each(['私の心がかき乱されています。', '自分の心がかき乱されています。', 'Aさんが話すと、私は心がかき乱されます。'])('retains an explicitly personal subject or owner: %s', user => {
    expect(containsUnsupportedEmotionIntensity('あなたは心がかき乱されているのですね。', [user])).toBe(false);
  });

  it.each([
    ['Aさんは心がかき乱されているそうです。', 'Aさんは心がかき乱されているのですね。'],
    ['息子の心がかき乱されています。', '息子の心がかき乱されているのですね。'],
  ])('keeps the same explicitly attributed third-party state without adopting it: %s', (user, reply) => {
    expect(containsUnsupportedEmotionIntensity(reply, [user])).toBe(false);
    expect(containsUnsupportedEmotionIntensity('あなたは心がかき乱されているのですね。', [user])).toBe(true);
  });

  it.each([
    ['Aさんは心がかき乱されています。', 'Aさんは心がかき乱されていません。', 'Aさんは心がかき乱されているのですね。'],
    ['息子の心がかき乱されています。', '息子の心がかき乱されていません。', '息子の心がかき乱されているのですね。'],
  ])('does not revive a denied third-party state: %s', (old, latest, reply) => {
    expect(containsUnsupportedEmotionIntensity(reply, [old, latest])).toBe(true);
  });

  it('does not use past intensity or a current calm correction as current support', () => {
    expect(containsUnsupportedEmotionIntensity('今は心がかき乱されているのですね。', ['以前は心がかき乱されていました。', '今は落ち着いています。'])).toBe(true);
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', ['心がかき乱されています。', '今は落ち着いています。'])).toBe(true);
    expect(containsUnsupportedEmotionIntensity('以前は心がかき乱されていたのですね。', ['以前は心がかき乱されていました。', '今は落ち着いています。'])).toBe(false);
  });

  it('keeps an explicit current feeling after a past feeling in the same message', () => {
    const users = ['以前は心が乱れていましたが、今は心がかき乱されています。'];
    expect(containsUnsupportedEmotionIntensity('今は心がかき乱されているのですね。', users)).toBe(false);
    expect(containsUnsupportedEmotionIntensity('以前は心が乱れていたのですね。', users)).toBe(false);
  });

  it('lets a plain current calm correction invalidate old intensity while retaining the past report', () => {
    const users = ['以前は心がかき乱されていました。', '心がかき乱されています。', '今は落ち着いた。'];
    expect(containsUnsupportedEmotionIntensity('今は心がかき乱されているのですね。', users)).toBe(true);
    expect(containsUnsupportedEmotionIntensity('以前は心がかき乱されていたのですね。', users)).toBe(false);
  });

  it.each([
    ['心が乱れています。', '心が乱れていません。', '心が乱れているのですね。'],
    ['心が乱れています。', '心が乱れていないのです。', '心が乱れているのですね。'],
    ['心がかき乱されています。', '心がかき乱されません。', '心がかき乱されているのですね。'],
    ['激しく動揺しています。', '激しく動揺していません。', '激しく動揺しているのですね。'],
  ])('does not affirm a denied conjugation or retain its older positive: %s / %s', (old, latest, reply) => {
    expect(containsUnsupportedEmotionIntensity(reply, [latest])).toBe(true);
    expect(containsUnsupportedEmotionIntensity(reply, [old, latest])).toBe(true);
    expect(containsUnsupportedEmotionIntensity(latest, [latest])).toBe(false);
  });

  it('does not exchange one stated strong emotion for a different one', () => {
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', ['激しく動揺しています。'])).toBe(true);
    expect(containsUnsupportedEmotionIntensity('激しく動揺しているのですね。', ['心がかき乱されています。'])).toBe(true);
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', ['少し心が乱れています。'])).toBe(true);
  });

  it.each(['', '。'])('keeps faithful third-party reporting including inner punctuation: %s', punctuation => {
    const user = `上司から「心がかき乱されている${punctuation}」と言われました。`;
    const reply = `上司から「心がかき乱されている${punctuation}」と言われたのですね。`;
    expect(containsUnsupportedEmotionIntensity(reply, [user])).toBe(false);
    expect(removeUnsupportedEmotionIntensity(reply, [user])).toBe(reply);
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', [user])).toBe(true);
    expect(containsUnsupportedEmotionIntensity('上司に「心がかき乱されています」と伝えてください。', [user])).toBe(true);
    const negative = `上司は「心がかき乱されている${punctuation}」とは言っていません。`;
    expect(containsUnsupportedEmotionIntensity(negative, [negative])).toBe(false);
    expect(containsUnsupportedEmotionIntensity(reply.replace('。', '、') + 'あなたも心がかき乱されています。', [user])).toBe(true);
  });

  it.each([
    '上司から「心がかき乱されている」と言われたのですね、あなたも心がかき乱されています。',
    '心がかき乱されているとは決めつけませんが、あなたは激しく動揺しています。',
    '心がかき乱されているとは決めつけませんがあなたは激しく動揺しています。',
    'もし心がかき乱されることがあれば相談できますが、あなたは激しく動揺しています。',
  ])('checks the separate assertion outside a faithful quote, negation or hypothetical: %s', reply => {
    expect(containsUnsupportedEmotionIntensity(reply, ['上司から「心がかき乱されている」と言われました。'])).toBe(true);
  });

  it('does not turn a substring or different speaker into a faithful quote', () => {
    expect(containsUnsupportedEmotionIntensity('上司から「心がかき乱される」と言われたのですね。', ['上司から「心がかき乱されるという表現は使わない」と言われました。'])).toBe(true);
    expect(containsUnsupportedEmotionIntensity('友人から「心がかき乱される」と言われたのですね。', ['上司から「心がかき乱される」と言われました。'])).toBe(true);
  });

  it('keeps the actual report while not adopting it after the user denies that state', () => {
    const user = '上司から「心がかき乱される」と言われましたが、私は心がかき乱されていません。';
    expect(containsUnsupportedEmotionIntensity('上司から「心がかき乱される」と言われたのですね。', [user])).toBe(false);
    expect(containsUnsupportedEmotionIntensity('心がかき乱されているのですね。', [user])).toBe(true);
  });

  it('does not use assistant speculation or old-topic feelings as current personal evidence', () => {
    const assistantOnly: CoachingChatMessage[] = [{ role: 'assistant', content: '心がかき乱されているのですね。' }];
    const oldTopic: CoachingChatMessage[] = [{ role: 'user', content: '以前の職場のことで心がかき乱されています。' }];
    for (const history of [assistantOnly, oldTopic]) {
      expect(assessCoachingResponseQuality({ text: '心がかき乱されているのですね。', lastUserText: '話題を変えて、新しい役割を引き受けるか迷っています。', historyMessages: history }).issues).toContain('context_mismatch');
    }
  });

  it.each(['minimal', 'legacy', 'observe'])('preserves personally affirmed intensity through assessment and normalization in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const latest = '新しい役割の話で、心がかき乱されています。自分の考えを話したいです。';
    const text = '新しい役割の話で、心がかき乱されているのですね。考えをすぐにまとめたり、引き受けるかどうかを今決めたりする必要はありません。役割の話を聞いたとき、どんな考えが最初に頭に浮かびましたか？';
    expect(assessCoachingResponseQuality({ text, lastUserText: latest, historyMessages: [] }).issues).not.toContain('context_mismatch');
    expect(normalizeCoachingOutput(text, latest)).toContain('心がかき乱されている');
  });

  it('detects the observed unreported intensity despite otherwise clean delivery', () => {
    expect(assessCoachingResponseQuality({ text: intensityCandidate, lastUserText: intensityLatest, historyMessages: intensityHistory }).issues).toContain('context_mismatch');
  });

  it('does not normalize hesitation into another unreported intense emotion', () => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', 'legacy');
    const text = normalizeCoachingOutput(intensityCandidate, intensityLatest, intensityHistory);
    expect(text).not.toMatch(/かき乱|掻き乱|激しく動揺|強い不安|心が疲れ/);
    expect(text).toMatch(/迷|新しい役割/);
    expect(text).toContain('？');
  });

  it.each(['minimal', 'legacy'])('keeps a question for an explicit deeper request in %s', mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    const latest = '定型的な整理ではなく、もう少し深く聞いてほしいです。';
    const text = 'もう少し深く、あなたが迷っている理由を聞いてほしいのですね。引き受ける場合と断る場合を思い浮かべて、それぞれで大切にしたいことを話せます。迷う理由をこちらで決めず、あなた自身の考えを出発点にします。\n\n引き受ける場合も断る場合も、後悔したくないことは何ですか？';
    const normalized = normalizeCoachingOutput(text, latest, [...intensityHistory, { role: 'user', content: intensityLatest }, { role: 'assistant', content: intensityCandidate }]);
    expect(normalized).toContain('後悔したくないことは何ですか？');
  });

  it.each(['minimal', 'legacy', 'observe'])('checks the actual delivery across the full stream in %s', async mode => {
    vi.stubEnv('COACHING_OUTPUT_PIPELINE_MODE', mode);
    vi.stubGlobal('fetch', () => { throw new Error('NETWORK_DISABLED'); });
    transport.raw = intensityCandidate; transport.repairs = 0;
    transport.instructions = [];
    let saved = '';
    const stream = createJsonLineStream({ systemPrompt: 'Synthetic emotion intensity regression.', historyMessages: intensityHistory,
      lastUserParts: buildGeminiParts(intensityLatest, [], intensityHistory), onDone: async (_usage, completion) => { saved = completion.message; return {}; } });
    const reader = stream.getReader(); const decoder = new TextDecoder(); let data = '';
    while (true) { const next = await reader.read(); if (next.done) break; data += decoder.decode(next.value); }
    const events = data.trim().split('\n').map(line => JSON.parse(line));
    const done = events.filter(event => event.type === 'done'); expect(done).toHaveLength(1);
    expect(done[0].completionStatus).toBe('complete'); expect(done[0].finalizationStatus).toBe('complete');
    expect(events.filter(event => event.type === 'chunk').map(event => event.text).join('')).toBe(done[0].message);
    expect(saved).toBe(done[0].message); expect(done[0].qualityInitialIssues).toContain('context_mismatch');
    expect(transport.instructions.every(instruction => instruction.includes('感情の種類や強さを追加しない'))).toBe(true);
    if (mode === 'legacy') { expect(transport.repairs).toBe(1); expect(transport.instructions).toHaveLength(2); }
    if (mode === 'observe') { expect(done[0].message).toBe(intensityCandidate); expect(done[0].qualityRepairAccepted).not.toBe(true); }
    else {
      expect(done[0].message).not.toMatch(/かき乱|掻き乱|激しく動揺|強い不安|心が疲れ/);
      expect(done[0].message).toMatch(/迷|新しい役割/);
      expect(done[0].message).not.toMatch(/明日.{0,20}5分|仕事全体|条件を一覧|まだ書かれていない原因を推測せず/);
      expect(done[0].qualityFinalIssues).toEqual([]);
    }
  });
});
