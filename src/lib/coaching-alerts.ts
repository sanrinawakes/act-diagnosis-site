const DEFAULT_ALERT_EMAILS = ['awakes2025@gmail.com', 'silversense.fzco@gmail.com'];
const ALERT_DELIVERY_TIMEOUT_MS = 8000;
const AUTOMATION_DELIVERY_REASON =
  'routed to ACTI Codex automation; operator email delivery is disabled';

const CODEX_RESPONSE_GUIDE = [
  '【ACTI自動対応】',
  'この異常はCodexのACTI自動対応タスクが定期取得し、ログ調査、再現、必要な修正、PR、CI、本番確認まで進めます。',
  'このメールをCodexへ手作業で貼り付ける必要はありません。',
  '同じ利用者への顧客返信は、原因と現在の状態を確認し、リリースゲートを満たした後だけ自動送信します。',
  '',
  '返金、料金、契約、解約、利用上限、一斉配信など経営・金銭判断を含む場合だけ、自動返信せず判断待ちとして保留します。',
].join('\n');

export function buildCoachingAlertText(params: {
  summary: string;
  details?: Record<string, unknown>;
  occurredAt?: Date;
}) {
  return [
    params.summary,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '詳細',
    JSON.stringify(params.details || {}, null, 2),
    '━━━━━━━━━━━━━━━━━━━━',
    `発生時刻: ${(params.occurredAt || new Date()).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    CODEX_RESPONSE_GUIDE,
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

export function getCoachingAlertDeliveryMode(
  environment: NodeJS.ProcessEnv = process.env
) {
  return environment.COACHING_ALERT_DELIVERY_MODE?.trim().toLowerCase() ===
    'email'
    ? ('email' as const)
    : ('automation' as const);
}

export async function sendCoachingAlert(params: {
  subject: string;
  summary: string;
  details?: Record<string, unknown>;
}): Promise<{
  accepted: boolean;
  channel: 'automation' | 'email';
  status?: number;
  id?: string;
  reason?: string;
}> {
  const deliveryMode = getCoachingAlertDeliveryMode();
  if (deliveryMode === 'automation') {
    console.info(
      JSON.stringify({
        event: 'coaching_alert_routed_to_automation',
        subject: params.subject,
        summary: params.summary,
        details: params.details || {},
      })
    );
    return {
      accepted: true,
      channel: 'automation',
      reason: AUTOMATION_DELIVERY_REASON,
    };
  }

  const resendApiKey = process.env.RESEND_API_KEY || '';
  if (!resendApiKey) {
    console.error('COACHING_ALERT_SKIPPED: RESEND_API_KEY is not configured');
    return {
      accepted: false,
      channel: 'email',
      reason: 'RESEND_API_KEY is not configured',
    };
  }

  const recipients = getAlertEmails();
  if (recipients.length === 0) {
    console.error('COACHING_ALERT_SKIPPED: no recipients configured');
    return {
      accepted: false,
      channel: 'email',
      reason: 'no recipients configured',
    };
  }

  const text = buildCoachingAlertText(params);
  const alertFromEmail =
    process.env.FROM_EMAIL || 'noreply@silversense.cc';
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    ALERT_DELIVERY_TIMEOUT_MS
  );

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: `ACTI Bot Monitor <${alertFromEmail}>`,
        to: recipients,
        subject: params.subject,
        text,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('COACHING_ALERT_FAILED', {
        status: response.status,
        body,
      });
      return {
        accepted: false,
        channel: 'email',
        status: response.status,
        reason: body.slice(0, 500),
      };
    }

    const responseBody = (await response.json().catch(() => null)) as {
      id?: string;
    } | null;
    return {
      accepted: true,
      channel: 'email',
      status: response.status,
      id: responseBody?.id,
    };
  } catch (error) {
    console.error('COACHING_ALERT_FAILED', error);
    return {
      accepted: false,
      channel: 'email',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getAlertEmails() {
  const configured =
    process.env.COACHING_ALERT_EMAILS ||
    process.env.SUPPORT_NOTIFICATION_CC_EMAILS ||
    DEFAULT_ALERT_EMAILS.join(',');

  return Array.from(
    new Set(
      configured
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}
