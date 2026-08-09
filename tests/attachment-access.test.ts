import { describe, expect, it } from 'vitest';
import {
  buildAttachmentViewUrl,
  isSafeAttachmentPath,
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

  it.each([
    'chat/758258f8-e5fa-4c4a-9493-5b976a76c5ef/2026-08-09/file.jpg',
    'chat/758258f8-e5fa-4c4a-9493-5b976a76c5ef/2026-08-09/画像_1.webp',
    'support/758258f8-e5fa-4c4a-9493-5b976a76c5ef/2026-08-09/report.v2.png',
    'support/758258f8-e5fa-4c4a-9493-5b976a76c5ef/inbound/2026-08-09/file.gif',
  ])('accepts an uploaded attachment path: %s', (path) => {
    expect(isSafeAttachmentPath(path)).toBe(true);
  });

  it.each([
    '',
    '/chat/user/date/file.png',
    'other/user/date/file.png',
    'chat/user/../file.png',
    'chat/user/date\\file.png',
    'chat/user//file.png',
    'chat/user/date/\u0000file.png',
  ])('rejects an unsafe attachment path: %s', (path) => {
    expect(isSafeAttachmentPath(path)).toBe(false);
  });
});
