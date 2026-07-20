import { describe, expect, it } from 'vitest';
import { mergeRecentCoachingMessages } from '../src/lib/coaching-session-memory';

describe('mergeRecentCoachingMessages', () => {
  it('DB側が直前のAI回答を欠いている時はリクエスト側の最新履歴を使う', () => {
    const current = { role: 'user' as const, content: '次の質問です。' };
    const merged = mergeRecentCoachingMessages(
      [
        { role: 'user', content: '最初の相談です。' },
        { role: 'assistant', content: '最初の回答です。' },
        current,
      ],
      [
        { role: 'user', content: '最初の相談です。' },
        { role: 'assistant', content: '最初の回答です。' },
        { role: 'user', content: '今夜の一言を教えてください。' },
        { role: 'assistant', content: '直前に提案した一言です。' },
        current,
      ]
    );

    expect(merged).toContainEqual({
      role: 'assistant',
      content: '直前に提案した一言です。',
    });
    expect(merged.at(-1)).toEqual(current);
  });

  it('リクエストが現在の一文だけならDB側の会話履歴を保持する', () => {
    const current = { role: 'user' as const, content: '次の質問です。' };
    const merged = mergeRecentCoachingMessages(
      [
        { role: 'user', content: '前の相談です。' },
        { role: 'assistant', content: '前の回答です。' },
        current,
      ],
      [current]
    );

    expect(merged).toHaveLength(3);
    expect(merged[1].content).toBe('前の回答です。');
  });

  it('同じ末尾履歴を二重に追加しない', () => {
    const history = [
      { role: 'user' as const, content: '相談です。' },
      { role: 'assistant' as const, content: '回答です。' },
      { role: 'user' as const, content: '続きです。' },
    ];

    expect(mergeRecentCoachingMessages(history, history)).toEqual(history);
  });
});
