import { describe, expect, it } from 'vitest';
import {
  mergeRecentCoachingMessages,
  shouldRefreshSessionMemory,
} from '../src/lib/coaching-session-memory';

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

describe('shouldRefreshSessionMemory', () => {
  it('直近24件を超えた最初の時点から要約を作る', () => {
    expect(shouldRefreshSessionMemory(24, null)).toBe(false);
    expect(shouldRefreshSessionMemory(25, null)).toBe(true);
  });

  it('25〜119件の会話でも古い発言との空白を残さない', () => {
    expect(shouldRefreshSessionMemory(40, 15)).toBe(true);
    expect(shouldRefreshSessionMemory(80, 55)).toBe(true);
    expect(shouldRefreshSessionMemory(119, 94)).toBe(true);
  });

  it('直近24件より前をすべてカバー済みなら書き直さない', () => {
    expect(shouldRefreshSessionMemory(80, 56)).toBe(false);
  });
});
