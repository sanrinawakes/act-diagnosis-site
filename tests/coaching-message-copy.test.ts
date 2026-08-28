import { describe, expect, it } from 'vitest';

import { getCopyableCoachingMessageText } from '../src/lib/coaching-message-copy';

describe('getCopyableCoachingMessageText', () => {
  it('copies visible coaching text without attachment markdown', () => {
    const content =
      '画像を確認しました。\n\n![添付画像](https://example.com/test.png)\n\n次はここを見てください。';

    expect(getCopyableCoachingMessageText(content)).toBe(
      '画像を確認しました。\n\n次はここを見てください。'
    );
  });

  it('returns an empty string when the message only contains attachments', () => {
    expect(
      getCopyableCoachingMessageText(
        '![添付画像](https://example.com/test.png)\n\n'
      )
    ).toBe('');
  });
});
