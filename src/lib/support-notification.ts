import type { SupportTechnicalContext } from '@/lib/support-ticket-context';

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
};

export function buildSupportNotificationEmail(
  input: SupportNotificationInput
) {
  const sourceLabel = getSupportSourceLabel(input.technicalContext);
  const pagePath = input.technicalContext.pagePath || '不明';
  const text = `
ACTI内の問い合わせフォームから、新しいサポートチケットを受け付けました。
※これは顧客から運営メールアドレスへ直接送られたメールではありません。

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
技術調査・修正・検証・顧客返信はACTI自動対応タスクが処理します。
返金、料金、契約、解約など判断が必要な内容だけ自動送信せず保留します。
━━━━━━━━━━━━━━━━━━━━
`.trim();

  return {
    subject: `[ACTI内フォーム受付] ${input.categoryLabel}: ${input.subject}`,
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
