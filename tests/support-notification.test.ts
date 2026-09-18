import { describe, expect, it } from 'vitest';
import { buildSupportNotificationEmail, getActiOperatorNotificationRecipients } from '@/lib/support-notification';
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
  ownerDecisionRequired: false,
};

describe('support notification email', () => {
  it('has only the requested operator recipient', () => {
    expect(getActiOperatorNotificationRecipients()).toEqual(['181wyc@gmail.com']);
  });
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
      '【ACTI・受付通知】途中から同じ返事をかえしてくる。意味不明'
    );
    expect(email.text).toContain('このメールは受付通知です。今すぐあなたが返信・判断する依頼ではありません。');
    expect(email.text).toContain('対象サービス: ACTI');
    expect(email.text).toContain('受付経路: ACTIのサポート画面');
    expect(email.text).toContain(
      'これは顧客から運営メールアドレスへ直接送られたメールではありません。'
    );
    expect(email.text).toContain('受付画面: /support');
    expect(email.text).toContain('会話ID: なし');
    expect(email.text).not.toContain('受付元: support');
  });

  it('makes a business decision request unmistakable', () => {
    const email = buildSupportNotificationEmail({
      ...baseInput,
      categoryLabel: 'お支払い',
      subject: '返金について',
      ownerDecisionRequired: true,
      technicalContext: normalizeSupportTechnicalContext({ source: 'support' }),
    });

    expect(email.subject).toBe('【ACTI・要判断】返金について');
    expect(email.text).toContain('あなたの判断が必要です');
    expect(email.text).toContain('とともにCodexへ伝えてください');
    expect(email.text).not.toContain('技術調査・修正・検証・顧客返信はACTI自動対応タスクが処理します');
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
