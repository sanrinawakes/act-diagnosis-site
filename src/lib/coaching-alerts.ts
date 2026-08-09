const AUTOMATION_DELIVERY_REASON =
  'routed to ACTI automation; operator email delivery is disabled';

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

export function getCoachingAlertDeliveryMode() {
  return 'automation' as const;
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
