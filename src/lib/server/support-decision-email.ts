import 'server-only';
import { getActiOperatorNotificationRecipients } from '@/lib/support-notification';

const RESEND_TIMEOUT_MS = 10_000;

type DecisionTicket = {
  id: string;
  name: string;
  email: string;
  category: string;
  subject: string;
};

type FetchLike = typeof fetch;

export function getSupportDecisionEmails() {
  return getActiOperatorNotificationRecipients();
}

export function buildSupportDecisionEmailText(params: {
  ticket: DecisionTicket;
  reason: string;
  adminUrl: string;
}) {
  return [
    'ACTIの利用者から届いた問い合わせについて、あなたの回答・判断が必要です。',
    'この案件は受付確認を除き、顧客への回答や確約を保留しています。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `チケットID: ${params.ticket.id}`,
    `カテゴリ: ${params.ticket.category}`,
    `送信者: ${params.ticket.name} <${params.ticket.email}>`,
    `件名: ${params.ticket.subject}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    '■ あなたに判断してほしいこと',
    params.reason,
    '',
    `確認画面: ${params.adminUrl}`,
    '',
    '管理画面で内容を確認し、判断内容を上記チケットIDとともにCodexへ伝えてください。',
    'この通知メールへの返信だけでは、判断内容はチケットに登録されません。',
    '判断が確定するまで、顧客への確約や料金・契約の変更は行いません。',
  ].join('\n');
}

export async function deliverSupportDecisionRequest(params: {
  ticket: DecisionTicket;
  reason: string;
  siteUrl?: string;
  apiKey?: string;
  fromEmail?: string;
  fetchImpl?: FetchLike;
}) {
  const apiKey = params.apiKey ?? process.env.RESEND_API_KEY ?? '';
  const fromEmail =
    params.fromEmail ?? process.env.FROM_EMAIL ?? 'noreply@silversense.cc';
  const recipients = getSupportDecisionEmails();
  const fetchImpl = params.fetchImpl ?? fetch;

  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  if (recipients.length === 0) {
    throw new Error('Support decision recipient is not configured');
  }

  const siteUrl = (
    params.siteUrl ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    'https://act-diagnosis-site.vercel.app'
  ).replace(/\/+$/, '');
  const idempotencyKey = `support-decision-${params.ticket.id}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: `ACTI 判断確認 <${fromEmail}>`,
        to: recipients,
        subject: `【ACTI・要判断】${params.ticket.subject}`,
        text: buildSupportDecisionEmailText({
          ticket: params.ticket,
          reason: params.reason,
          adminUrl: `${siteUrl}/admin/support`,
        }),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let responseBody: Record<string, unknown> | string = responseText;
  try {
    responseBody = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    // Keep a non-JSON provider response for the error report.
  }

  if (!response.ok) {
    throw new Error(
      `Decision notification failed (${response.status}): ${JSON.stringify(responseBody).slice(0, 500)}`
    );
  }

  return {
    success: true,
    idempotencyKey,
    resendId:
      typeof responseBody === 'object' && typeof responseBody.id === 'string'
        ? responseBody.id
        : null,
    recipients,
  };
}
