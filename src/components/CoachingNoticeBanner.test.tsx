import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CoachingNoticeBanner from '@/components/CoachingNoticeBanner';

describe('CoachingNoticeBanner', () => {
  it('renders an accessible, prominent notice with the supplied Japanese text', () => {
    const markup = renderToStaticMarkup(
      createElement(CoachingNoticeBanner, {
        title: 'AIコーチングBotのエラー対応について',
        body: '現在、修正と検証を進めています。\n数日お待ちください。',
        className: 'dashboard-notice',
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-testid="coaching-notice"');
    expect(markup).toContain('border-red-600');
    expect(markup).toContain('dashboard-notice');
    expect(markup).toContain('重要なお知らせ');
    expect(markup).toContain('AIコーチングBotのエラー対応について');
    expect(markup).toContain('現在、修正と検証を進めています。\n数日お待ちください。');
  });
});
