import { describe, expect, it } from 'vitest';
import {
  buildAttachmentViewUrl,
  parseAttachmentMarkdown,
  SIGNED_URL_EXPIRES_IN,
} from '../src/lib/attachments';

describe('attachment access links', () => {
  it('keeps stored attachment references behind the authenticated viewer route', () => {
    const path = 'chat/user-123/2026-08-08/file.png';
    const url = buildAttachmentViewUrl(path);
    const parsed = parseAttachmentMarkdown(`![test](${url})`);

    expect(url).toBe('/api/attachments?path=chat%2Fuser-123%2F2026-08-08%2Ffile.png');
    expect(parsed.attachments).toEqual([{ label: 'test', url }]);
  });

  it('limits storage URLs to a short-lived redirect instead of storing a multi-year credential', () => {
    expect(SIGNED_URL_EXPIRES_IN).toBe(60 * 15);
  });
});
