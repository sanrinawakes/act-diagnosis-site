import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveChatAttachments,
  validateChatAttachments,
} from '../src/lib/server-chat-attachments';

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

describe('resolveChatAttachments', () => {
  const storedAttachment = {
    name: 'image.png',
    mimeType: 'image/png',
    path: `chat/${userId}/2026-07-21/image.png`,
  };

  it('保存画像をキャッシュせず読み込む', async () => {
    const download = vi.fn().mockResolvedValue({
      data: new Blob(['image-bytes']),
      error: null,
    });

    const result = await resolveChatAttachments(
      [storedAttachment],
      createStorageClient(download),
      { attemptTimeoutMs: 50, retryDelaysMs: [] }
    );

    expect(result).toEqual([
      {
        name: 'image.png',
        mimeType: 'image/png',
        data: Buffer.from('image-bytes').toString('base64'),
      },
    ]);
    expect(download).toHaveBeenCalledWith(
      storedAttachment.path,
      {},
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        cache: 'no-store',
      })
    );
  });

  it('最初のダウンロードが固まっても中断して再試行する', async () => {
    const download = vi
      .fn()
      .mockImplementationOnce(
        (_path, _options, parameters: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            parameters.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          })
      )
      .mockResolvedValueOnce({
        data: new Blob(['retry-success']),
        error: null,
      });
    const onRetry = vi.fn();

    const result = await resolveChatAttachments(
      [storedAttachment],
      createStorageClient(download),
      { attemptTimeoutMs: 5, retryDelaysMs: [0], onRetry }
    );

    expect(result[0].data).toBe(
      Buffer.from('retry-success').toString('base64')
    );
    expect(download).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIndex: 0, nextAttempt: 2 })
    );
  });

  it('一時エラーが続く場合は上限回数で停止する', async () => {
    const download = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'temporary storage error' },
    });

    await expect(
      resolveChatAttachments(
        [storedAttachment],
        createStorageClient(download),
        { attemptTimeoutMs: 50, retryDelaysMs: [0, 0] }
      )
    ).rejects.toThrow('ATTACHMENT_DOWNLOAD_FAILED');
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('すべての試行が固まった場合はタイムアウトとして返す', async () => {
    const download = vi.fn().mockImplementation(
      (_path, _options, parameters: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          parameters.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })
    );

    await expect(
      resolveChatAttachments(
        [storedAttachment],
        createStorageClient(download),
        { attemptTimeoutMs: 5, retryDelaysMs: [0, 0] }
      )
    ).rejects.toThrow('ATTACHMENT_LOAD_TIMEOUT');
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('3枚の保存画像を並列で読み込む', async () => {
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    const download = vi.fn().mockImplementation(async () => {
      activeDownloads += 1;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDownloads -= 1;
      return { data: new Blob(['ok']), error: null };
    });

    const result = await resolveChatAttachments(
      [0, 1, 2].map((index) => ({
        ...storedAttachment,
        name: `${index}.png`,
        path: `${storedAttachment.path}-${index}`,
      })),
      createStorageClient(download),
      { attemptTimeoutMs: 50, retryDelaysMs: [] }
    );

    expect(result).toHaveLength(3);
    expect(maxActiveDownloads).toBe(3);
  });

  it('壊れたサイズのデータは再試行しない', async () => {
    const download = vi.fn().mockResolvedValue({
      data: new Blob([]),
      error: null,
    });

    await expect(
      resolveChatAttachments(
        [storedAttachment],
        createStorageClient(download),
        { attemptTimeoutMs: 50, retryDelaysMs: [0, 0] }
      )
    ).rejects.toThrow('ATTACHMENT_SIZE_INVALID');
    expect(download).toHaveBeenCalledTimes(1);
  });
});

function createStorageClient(download: ReturnType<typeof vi.fn>) {
  return {
    storage: {
      from: vi.fn(() => ({ download })),
    },
  } as unknown as SupabaseClient;
}
