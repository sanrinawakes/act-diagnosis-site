import { describe, expect, it } from 'vitest';
import { validateChatAttachments } from '../src/lib/server-chat-attachments';

const userId = '11111111-1111-4111-8111-111111111111';

describe('validateChatAttachments', () => {
  it('従来の正常なBase64画像を受け付ける', () => {
    expect(
      validateChatAttachments(
        [{ name: 'image.png', mimeType: 'image/png', data: 'aGVsbG8=' }],
        null
      )
    ).toBe('');
  });

  it('ログイン本人の保存画像だけを受け付ける', () => {
    expect(
      validateChatAttachments(
        [
          {
            name: 'image.png',
            mimeType: 'image/png',
            path: `chat/${userId}/2026-07-19/image.png`,
          },
        ],
        userId
      )
    ).toBe('');
  });

  it('他会員の保存画像参照を拒否する', () => {
    expect(
      validateChatAttachments(
        [
          {
            name: 'image.png',
            mimeType: 'image/png',
            path: 'chat/22222222-2222-4222-8222-222222222222/2026-07-19/image.png',
          },
        ],
        userId
      )
    ).toContain('不正');
  });

  it('親ディレクトリを含む保存先を拒否する', () => {
    expect(
      validateChatAttachments(
        [
          {
            name: 'image.png',
            mimeType: 'image/png',
            path: `chat/${userId}/../other/image.png`,
          },
        ],
        userId
      )
    ).toContain('不正');
  });

  it('4MBを超えるBase64画像を拒否する', () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    expect(
      validateChatAttachments(
        [{ name: 'large.png', mimeType: 'image/png', data: oversized }],
        null
      )
    ).toContain('4MB');
  });

  it('画像4枚を拒否する', () => {
    const attachments = Array.from({ length: 4 }, (_, index) => ({
      name: `${index}.png`,
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    }));
    expect(validateChatAttachments(attachments, null)).toContain('最大3枚');
  });
});
