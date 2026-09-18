import type { SupportTechnicalContext } from '@/lib/support-ticket-context';

export const ACTI_OPERATOR_NOTIFICATION_EMAIL = '181wyc@gmail.com';
export const getActiOperatorNotificationRecipients = () => [ACTI_OPERATOR_NOTIFICATION_EMAIL];

type SupportNotificationInput = {
  ticketId: string;
  categoryLabel: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  attachmentText: string;
  technicalContext: SupportTechnicalContext;
  sentAt: string;
  adminUrl: string;
  ownerDecisionRequired: boolean;
};

export function buildSupportNotificationEmail(
  input: SupportNotificationInput
) {
  const sourceLabel = getSupportSourceLabel(input.technicalContext);
  const pagePath = input.technicalContext.pagePath || '不明';
  const action = input.ownerDecisionRequired
    ? [
        'あなたの判断が必要です。料金・返金・契約などについて、受付確認を除き、顧客への回答や確約を保留しています。',
        `問い合わせを確認し、判断内容をチケットID ${input.ticketId} とともにCodexへ伝えてください。`,
      ]
    : [
        'このメールは受付通知です。今すぐあなたが返信・判断する依頼ではありません。',
        '問い合わせの処理状況は管理画面と日次レポートで確認できます。',
      ];
  const text = `
ACTIの利用者から、問い合わせフォームに質問が届きました。
※これは顧客から運営メールアドレスへ直接送られたメールではありません。

■ あなたに必要な対応
${action.join('\n')}

━━━━━━━━━━━━━━━━━━━━
対象サービス: ACTI
チケットID: ${input.ticketId}
カテゴリ: ${input.categoryLabel}
受付経路: ${sourceLabel}
━━━━━━━━━━━━━━━━━━━━

■ 送信者情報
名前: ${input.name}
メール: ${input.email}

■ 件名
${input.subject}

■ 内容
${input.message}
${input.attachmentText}

■ 技術情報
受付画面: ${pagePath}
会話ID: ${input.technicalContext.sessionId || 'なし'}
本番コミット: ${input.technicalContext.deploymentCommit || '不明'}

━━━━━━━━━━━━━━━━━━━━
送信日時: ${input.sentAt}
管理画面: ${input.adminUrl}
このメールをお客様へ転送しないでください。
━━━━━━━━━━━━━━━━━━━━
`.trim();

  return {
    subject: `${input.ownerDecisionRequired ? '【ACTI・要判断】' : '【ACTI・受付通知】'}${input.subject}`,
    text,
  };
}

export function getSupportSourceLabel(
  context: Pick<SupportTechnicalContext, 'source'>
) {
  if (context.source === 'coaching') {
    return 'ACTI AIコーチング画面内の「AIサポートにメッセージ」';
  }

  if (context.source === 'support') {
    return 'ACTIのサポート画面';
  }

  return 'ACTI内の問い合わせフォーム';
}
