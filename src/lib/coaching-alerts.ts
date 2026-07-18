const DEFAULT_ALERT_EMAILS = ['awakes2025@gmail.com', 'silversense.fzco@gmail.com'];
const ALERT_FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@silversense.cc';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

const CODEX_RESPONSE_GUIDE = [
  '【SAORIさん：この監視メールをCodexで対応する方法】',
  'スタッフPCのCodexでACTIプロジェクトを開き、このメール全文を貼り付けて、そのまま送信してください。',
  'GitHub・Vercel・Supabaseの必要な権限は awakes2025 に共有済みです。権限の再追加依頼は不要です。',
  '',
  '【Codexへの指示】',
  'これはACTIの本番監視通知です。最初にプロジェクトのAGENTS.mdを読み、次の順に対応してください。',
  '1. 通知の発生時刻前後のVercel本番ログと、最新デプロイの状態を確認する。',
  '2. 実際の障害か監視の誤検知かを、ログのHTTP状態・stream完了・処理時間から判定する。',
  '3. 本番の監視APIを再実行する。',
  '4. 通常会話と長い会話履歴のスモークテストを本番で実行する。',
  '5. 不具合が確認できた場合は、原因を修正し、ビルド・本番反映・本番再テストまで行う。',
  '6. 最後に、判定・原因・変更内容・テスト数値・現在の状態を日本語で報告する。',
  '検証結果がない状態で「完了」「復旧」「問題なし」と報告しないでください。',
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

export async function sendCoachingAlert(params: {
  subject: string;
  summary: string;
  details?: Record<string, unknown>;
}) {
  if (!RESEND_API_KEY) {
    console.error('COACHING_ALERT_SKIPPED: RESEND_API_KEY is not configured');
    return;
  }

  const recipients = getAlertEmails();
  if (recipients.length === 0) {
    console.error('COACHING_ALERT_SKIPPED: no recipients configured');
    return;
  }

  const text = buildCoachingAlertText(params);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `ACTI Bot Monitor <${ALERT_FROM_EMAIL}>`,
        to: recipients,
        subject: params.subject,
        text,
      }),
    });

    if (!response.ok) {
      console.error('COACHING_ALERT_FAILED', {
        status: response.status,
        body: await response.text(),
      });
    }
  } catch (error) {
    console.error('COACHING_ALERT_FAILED', error);
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
