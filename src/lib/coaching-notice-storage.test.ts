import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COACHING_NOTICE_SETTINGS,
  INTERIM_DEFAULT_COACHING_NOTICE_BODY,
  PREVIOUS_DEFAULT_COACHING_NOTICE_BODY,
} from '@/lib/site-settings';

vi.mock('server-only', () => ({}));

import {
  loadCoachingNoticeSettings,
  saveCoachingNoticeSettings,
} from '@/lib/coaching-notice-storage';

function createStorageClient(options?: {
  downloadData?: Blob | null;
  downloadError?: unknown;
  uploadError?: unknown;
}) {
  const download = vi.fn().mockResolvedValue({
    data: options?.downloadData ?? null,
    error: options?.downloadError ?? null,
  });
  const upload = vi.fn().mockResolvedValue({
    data: null,
    error: options?.uploadError ?? null,
  });
  const from = vi.fn().mockReturnValue({ download, upload });

  return {
    client: { storage: { from } } as unknown as SupabaseClient,
    download,
    upload,
    from,
  };
}

describe('coaching notice storage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and trims a stored notice from the existing attachment bucket', async () => {
    const storage = createStorageClient({
      downloadData: new Blob([
        JSON.stringify({
          coaching_notice_enabled: true,
          coaching_notice_title: '  保存済みの見出し  ',
          coaching_notice_body: '  保存済みの本文  ',
        }),
      ]),
    });

    await expect(loadCoachingNoticeSettings(storage.client)).resolves.toEqual({
      coaching_notice_enabled: true,
      coaching_notice_title: '保存済みの見出し',
      coaching_notice_body: '保存済みの本文',
    });
    expect(storage.from).toHaveBeenCalledWith('acti-attachments');
    expect(storage.download).toHaveBeenCalledWith('system/coaching-notice.json');
  });

  it('uses the enabled apology when no saved notice exists', async () => {
    const storage = createStorageClient({
      downloadError: { message: 'Object not found' },
    });

    await expect(loadCoachingNoticeSettings(storage.client)).resolves.toEqual(
      DEFAULT_COACHING_NOTICE_SETTINGS
    );
  });

  it('replaces the previous stop-using wording even when it was saved', async () => {
    const storage = createStorageClient({
      downloadData: new Blob([
        JSON.stringify({
          coaching_notice_enabled: true,
          coaching_notice_title: 'AIコーチングBotのご利用について',
          coaching_notice_body: PREVIOUS_DEFAULT_COACHING_NOTICE_BODY,
        }),
      ]),
    });

    await expect(loadCoachingNoticeSettings(storage.client)).resolves.toEqual(
      DEFAULT_COACHING_NOTICE_SETTINGS
    );
  });

  it('replaces the interim apology wording even when it was saved', async () => {
    const storage = createStorageClient({
      downloadData: new Blob([
        JSON.stringify({
          coaching_notice_enabled: true,
          coaching_notice_title: 'AIコーチングBotのエラー対応について',
          coaching_notice_body: INTERIM_DEFAULT_COACHING_NOTICE_BODY,
        }),
      ]),
    });

    await expect(loadCoachingNoticeSettings(storage.client)).resolves.toEqual(
      DEFAULT_COACHING_NOTICE_SETTINGS
    );
  });

  it('preserves an administrator choice to hide the previous notice', async () => {
    const storage = createStorageClient({
      downloadData: new Blob([
        JSON.stringify({
          coaching_notice_enabled: false,
          coaching_notice_title: 'AIコーチングBotのご利用について',
          coaching_notice_body: PREVIOUS_DEFAULT_COACHING_NOTICE_BODY,
        }),
      ]),
    });

    await expect(loadCoachingNoticeSettings(storage.client)).resolves.toEqual({
      ...DEFAULT_COACHING_NOTICE_SETTINGS,
      coaching_notice_enabled: false,
    });
  });

  it('saves the exact notice as JSON with cache disabled and upsert enabled', async () => {
    const storage = createStorageClient();
    const notice = {
      coaching_notice_enabled: true,
      coaching_notice_title: '見出し',
      coaching_notice_body: '本文',
    };

    await saveCoachingNoticeSettings(storage.client, notice);

    expect(storage.from).toHaveBeenCalledWith('acti-attachments');
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const [path, content, uploadOptions] = storage.upload.mock.calls[0];
    expect(path).toBe('system/coaching-notice.json');
    expect(JSON.parse(new TextDecoder().decode(content))).toEqual(notice);
    expect(uploadOptions).toEqual({
      cacheControl: '0',
      contentType: 'application/json; charset=utf-8',
      upsert: true,
    });
  });

  it('rejects an enabled blank notice before attempting storage upload', async () => {
    const storage = createStorageClient();

    await expect(
      saveCoachingNoticeSettings(storage.client, {
        coaching_notice_enabled: true,
        coaching_notice_title: '',
        coaching_notice_body: '本文',
      })
    ).rejects.toThrow('見出し');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('surfaces storage upload failures to the admin API', async () => {
    const storage = createStorageClient({
      uploadError: new Error('storage unavailable'),
    });

    await expect(
      saveCoachingNoticeSettings(storage.client, DEFAULT_COACHING_NOTICE_SETTINGS)
    ).rejects.toThrow('storage unavailable');
  });
});
