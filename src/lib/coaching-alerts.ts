const DEFAULT_ALERT_EMAILS = ['awakes2025@gmail.com', 'silversense.fzco@gmail.com'];
const ALERT_FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@silversense.cc';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

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

  const text = [
    params.summary,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '詳細',
    JSON.stringify(params.details || {}, null, 2),
    '━━━━━━━━━━━━━━━━━━━━',
    `発生時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
  ].join('\n');

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
