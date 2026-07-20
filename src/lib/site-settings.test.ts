import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COACHING_NOTICE_SETTINGS,
  getVisibleCoachingNotice,
  parseSiteSettingsPatch,
  validateEnabledCoachingNotice,
} from '@/lib/site-settings';

describe('getVisibleCoachingNotice', () => {
  it('uses an enabled Japanese apology as the production fallback', () => {
    expect(DEFAULT_COACHING_NOTICE_SETTINGS.coaching_notice_enabled).toBe(true);
    expect(DEFAULT_COACHING_NOTICE_SETTINGS.coaching_notice_title).toBe(
      'AIコーチングBotのエラー対応について'
    );
    expect(DEFAULT_COACHING_NOTICE_SETTINGS.coaching_notice_body).toContain(
      '十分な確認が終わる前に「改善しました」とご案内してしまい、本当に申し訳ございません。'
    );
    expect(DEFAULT_COACHING_NOTICE_SETTINGS.coaching_notice_body).toContain(
      'AIコーチングBotは引き続きご利用いただけます。'
    );
    expect(DEFAULT_COACHING_NOTICE_SETTINGS.coaching_notice_body).toContain(
      'こちらでも動作を監視しており、検知したエラーは順次、原因を確認して修正しています。'
    );
    expect(DEFAULT_COACHING_NOTICE_SETTINGS.coaching_notice_body).toContain(
      'その間もAIコーチングBotをお使いいただきながら'
    );
    expect(DEFAULT_COACHING_NOTICE_SETTINGS.coaching_notice_body).not.toContain(
      'ご利用を数日お待ちくださいますよう'
    );
  });

  it('returns a trimmed notice when it is enabled and complete', () => {
    expect(
      getVisibleCoachingNotice({
        coaching_notice_enabled: true,
        coaching_notice_title: '  お知らせ  ',
        coaching_notice_body: '  本文です。  ',
      })
    ).toEqual({ title: 'お知らせ', body: '本文です。' });
  });

  it('hides disabled or incomplete notices', () => {
    expect(
      getVisibleCoachingNotice({
        coaching_notice_enabled: false,
        coaching_notice_title: 'お知らせ',
        coaching_notice_body: '本文です。',
      })
    ).toBeNull();
    expect(
      getVisibleCoachingNotice({
        coaching_notice_enabled: true,
        coaching_notice_title: 'お知らせ',
        coaching_notice_body: '   ',
      })
    ).toBeNull();
  });
});

describe('parseSiteSettingsPatch', () => {
  it('accepts supported fields and trims text', () => {
    expect(
      parseSiteSettingsPatch({
        bot_enabled: false,
        coaching_notice_enabled: true,
        coaching_notice_title: '  見出し  ',
        coaching_notice_body: '  本文  ',
      })
    ).toEqual({
      bot_enabled: false,
      coaching_notice_enabled: true,
      coaching_notice_title: '見出し',
      coaching_notice_body: '本文',
    });
  });

  it('rejects invalid types and empty patches', () => {
    expect(() => parseSiteSettingsPatch({ bot_enabled: 'true' })).toThrow(
      'true または false'
    );
    expect(() => parseSiteSettingsPatch({ unknown: true })).toThrow(
      '変更する設定がありません'
    );
  });
});

describe('validateEnabledCoachingNotice', () => {
  it('requires a title and body only while the notice is enabled', () => {
    expect(() =>
      validateEnabledCoachingNotice({
        coaching_notice_enabled: false,
        coaching_notice_title: '',
        coaching_notice_body: '',
      })
    ).not.toThrow();
    expect(() =>
      validateEnabledCoachingNotice({
        coaching_notice_enabled: true,
        coaching_notice_title: '',
        coaching_notice_body: '本文',
      })
    ).toThrow('見出し');
    expect(() =>
      validateEnabledCoachingNotice({
        coaching_notice_enabled: true,
        coaching_notice_title: '見出し',
        coaching_notice_body: '',
      })
    ).toThrow('本文');
  });
});
