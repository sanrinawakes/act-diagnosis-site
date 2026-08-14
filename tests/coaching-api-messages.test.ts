import { describe, expect, it } from 'vitest';
import {
  buildFallbackCoachingApiMessages,
  type CoachingApiMessage,
} from '@/lib/coaching-api-messages';

describe('buildFallbackCoachingApiMessages', () => {
  it('caps a long fallback history to the newest API-safe window', () => {
    const messages: CoachingApiMessage[] = Array.from(
      { length: 130 },
      (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index + 1}`,
      })
    );
    messages.push({
      role: 'user',
      content: 'latest-user-message',
    });

    const result = buildFallbackCoachingApiMessages(messages, 24);

    expect(result).toHaveLength(24);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'message-108',
    });
    expect(result.at(-1)).toEqual({
      role: 'user',
      content: 'latest-user-message',
    });
  });

  it('drops blank rows before applying the limit', () => {
    const result = buildFallbackCoachingApiMessages(
      [
        { role: 'assistant', content: '  ' },
        { role: 'user', content: '相談内容' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: '返答候補' },
      ],
      24
    );

    expect(result).toEqual([
      { role: 'user', content: '相談内容' },
      { role: 'assistant', content: '返答候補' },
    ]);
  });
});
