import 'server-only';

const DEFAULT_SUPPORT_DECISION_EMAIL = '181wyc@gmail.com';
const RESEND_TIMEOUT_MS = 10_000;

type DecisionTicket = {
  id: string;
  name: string;
  email: string;
  category: string;
  subject: string;
};

type FetchLike = typeof fetch;

export function getSupportDecisionEmails(
  configuredEmails =
    process.env.SUPPORT_DECISION_EMAILS ||
    process.env.SUPPORT_DECISION_EMAIL ||
    DEFAULT_SUPPORT_DECISION_EMAIL
) {
  return Array.from(
    new Set(
      configuredEmails
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
  );
}

export function buildSupportDecisionEmailText(params: {
  ticket: DecisionTicket;
  reason: string;
  adminUrl: string;
}) {
  return [
    'ACTIサポートで、経営判断が必要な問い合わせを保留しました。',
    '技術調査や事実確認は自動対応を継続し、料金・返金・契約・利用条件などの決定だけを確認します。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `チケットID: ${params.ticket.id}`,
    `カテゴリ: ${params.ticket.category}`,
    `送信者: ${params.ticket.name} <${params.ticket.email}>`,
    `件名: ${params.ticket.subject}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    '■ 判断してほしいこと',
    params.reason,
    '',
    `確認画面: ${params.adminUrl}`,
    '',
    '判断内容をCodexへ伝える際は、上記チケットIDを添えてください。',
    '判断が確定するまで、顧客への確約や料金・契約の変更は行いません。',
  ].join('\n');
}

export async function deliverSupportDecisionRequest(params: {
  ticket: DecisionTicket;
  reason: string;
  siteUrl?: string;
  apiKey?: string;
  fromEmail?: string;
  recipients?: string[];
  fetchImpl?: FetchLike;
}) {
  const apiKey = params.apiKey ?? process.env.RESEND_API_KEY ?? '';
  const fromEmail =
    params.fromEmail ?? process.env.FROM_EMAIL ?? 'noreply@silversense.cc';
  const recipients = params.recipients ?? getSupportDecisionEmails();
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
        subject: `[ACTI 判断依頼] ${params.ticket.subject}`,
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
