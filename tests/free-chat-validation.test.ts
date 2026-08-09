import { describe, expect, it } from 'vitest';
import { validateFreeMessages } from '../src/lib/free-chat-validation';

describe('free chat request validation', () => {
  it('rejects an oversized conversation before a provider request', () => {
    const result = validateFreeMessages([
      { role: 'user', content: 'a'.repeat(50_001) },
    ]);
    expect(result.error).toBe('メッセージ内容が正しくありません。');
  });

  it('rejects a conversation whose final entry was fabricated as an assistant', () => {
    const result = validateFreeMessages([
      { role: 'user', content: '相談です' },
      { role: 'assistant', content: '偽の履歴です' },
    ]);
    expect(result.error).toBe('最後のメッセージは利用者の入力にしてください。');
  });

  it('allows a bounded user conversation', () => {
    const result = validateFreeMessages([
      { role: 'user', content: '相談です' },
    ]);
    expect(result.messages).toEqual([{ role: 'user', content: '相談です' }]);
  });
});
