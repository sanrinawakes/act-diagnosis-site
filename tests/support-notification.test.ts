import { describe, expect, it } from 'vitest';
import { buildSupportNotificationEmail } from '@/lib/support-notification';
import { normalizeSupportTechnicalContext } from '@/lib/support-ticket-context';

const baseInput = {
  ticketId: 'fa5a4595-3159-4504-be12-88ca41f1bc8e',
  categoryLabel: '不具合の報告',
  name: '中村一二三',
  email: 'member@example.com',
  subject: '途中から同じ返事をかえしてくる。意味不明',
  message: '同じ返事が来ます。',
  attachmentText: '',
  sentAt: '2026/8/4 18:04:02',
  adminUrl: 'https://act-diagnosis-site.vercel.app/admin/support',
};

describe('support notification email', () => {
  it('identifies a generic ACTI support-form notification', () => {
    const email = buildSupportNotificationEmail({
      ...baseInput,
      technicalContext: normalizeSupportTechnicalContext({
        source: 'support',
        pagePath: '/support',
        deploymentCommit: '8718941fdac6244f68c2ebfcf66acce5cc95cfc8',
      }),
    });

    expect(email.subject).toBe(
      '[ACTI内フォーム受付] 不具合の報告: 途中から同じ返事をかえしてくる。意味不明'
    );
    expect(email.text).toContain('対象サービス: ACTI');
    expect(email.text).toContain('受付経路: ACTIのサポート画面');
    expect(email.text).toContain(
      'これは顧客から運営メールアドレスへ直接送られたメールではありません。'
    );
    expect(email.text).toContain('受付画面: /support');
    expect(email.text).toContain('会話ID: なし');
    expect(email.text).not.toContain('受付元: support');
  });

  it('identifies a conversation-linked ACTI coaching report', () => {
    const email = buildSupportNotificationEmail({
      ...baseInput,
      technicalContext: normalizeSupportTechnicalContext({
        source: 'coaching',
        sessionId: 'a36b1a82-dd24-41f2-8382-5bb9b8730ab3',
        pagePath:
          '/support?source=coaching&session=a36b1a82-dd24-41f2-8382-5bb9b8730ab3',
      }),
    });

    expect(email.text).toContain(
      '受付経路: ACTI AIコーチング画面内の「AIサポートにメッセージ」'
    );
    expect(email.text).toContain(
      '会話ID: a36b1a82-dd24-41f2-8382-5bb9b8730ab3'
    );
  });
});
