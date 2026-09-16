import { describe, expect, it } from 'vitest';
import {
  assessCoachingResponseQuality,
  buildFinalVerifiedQualityFallback,
  ensureVerifiedCoachingResolution,
} from '../src/lib/coaching-gemini';
import type { CoachingChatMessage } from '../src/lib/coaching-gemini';

const history: CoachingChatMessage[] = [
  { role: 'user', content: '貯金を増やしたいです。' },
  { role: 'assistant', content: '毎月いくら貯められますか？' },
  { role: 'user', content: '残念ですが、余裕がないです。' },
  { role: 'assistant', content: '「貯金を増やしたい」という相談ですね。' },
];

describe('no-surplus savings response recovery', () => {
  it.each(['毎月貯金をしたくても、余裕がないです', '毎月の生活費で精一杯で、貯金に回せません'])('does not repeat a customer statement: %s', (lastUserText) => {
    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: `「${lastUserText}」という相談ですね。`,
        usage: {}, modelName: 'test', repairAttempted: false,
        repairAccepted: false, initialIssues: ['too_short'],
        finalIssues: ['too_short', 'latest_user_echo'],
      },
      lastUserText,
      historyMessages: history,
    });
    expect(result.finalIssues).toEqual([]);
    expect(result.text).not.toContain('という相談ですね');
    expect(result.text).toMatch(/貯金|生活費/);
    expect(result.text).toMatch(/手取り|収入|支出/);
    expect(result.text).not.toMatch(/毎月いくら貯め|まず貯金額を決め/);
    expect(result.chargeable).toBe(false);
  });

  it('keeps the direct fallback clean and grounded', () => {
    const lastUserText = '毎月貯金をしたくても、余裕がないです';
    const text = buildFinalVerifiedQualityFallback(lastUserText, history);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: history }).issues).toEqual([]);
  });

  it('uses the previous savings question when the reply only says there is no room', () => {
    const lastUserText = '残念ですが、余裕がないです';
    const shorterHistory = history.slice(0, 2);
    const text = buildFinalVerifiedQualityFallback(lastUserText, shorterHistory);
    expect(text).toContain('貯金額');
    expect(text).not.toContain('という相談ですね');
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: shorterHistory }).issues).toEqual([]);
  });

  it('asks about the writer rather than changing a friend when declining plans', () => {
    const lastUserText = '友人に断りたい予定があるのに、返事を先延ばしにしています。';
    const direct = buildFinalVerifiedQualityFallback(lastUserText, []);
    expect(assessCoachingResponseQuality({ text: direct, lastUserText, historyMessages: [] }).issues).toEqual([]);
    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: '「友人に断りたい予定があるのに、返事を先延ばしにしています」という相談ですね。',
        usage: {}, modelName: 'test', repairAttempted: false,
        repairAccepted: false, initialIssues: ['too_short'],
        finalIssues: ['too_short', 'latest_user_echo'],
      },
      lastUserText,
      historyMessages: [],
    });
    expect(result.finalIssues).toEqual([]);
    expect(result.text).not.toMatch(/相手に、まずどの行動を変えて|という相談ですね/);
    expect(result.text).toMatch(/断る|返事/);
    expect(result.text).toContain('何が気になって');
  });
});
