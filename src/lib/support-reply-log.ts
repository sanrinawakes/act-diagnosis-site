export const SUPPORT_REPLY_LOG_HEADER = '\n\n----- ACTI SUPPORT REPLY LOG -----\n';

export type SupportReplyLogEntry = {
  sentAt: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  deliveryStatus: 'sent' | 'failed';
  resendId?: string;
  error?: string;
};

export function splitSupportMessage(message: string) {
  const markerIndex = message.indexOf(SUPPORT_REPLY_LOG_HEADER);

  if (markerIndex === -1) {
    return {
      customerMessage: message,
      replyLog: '',
    };
  }

  return {
    customerMessage: message.slice(0, markerIndex).trimEnd(),
    replyLog: message.slice(markerIndex + SUPPORT_REPLY_LOG_HEADER.length).trim(),
  };
}

export function buildSupportReplyLogEntry(entry: SupportReplyLogEntry) {
  const sentAtJa = new Date(entry.sentAt).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
  });

  return [
    `送信日時: ${sentAtJa}`,
    `送信者: ${entry.senderEmail}`,
    `宛先: ${entry.toEmail}`,
    `件名: ${entry.subject}`,
    `送信結果: ${entry.deliveryStatus}`,
    entry.resendId ? `Resend ID: ${entry.resendId}` : null,
    entry.error ? `エラー: ${entry.error}` : null,
    '',
    '本文:',
    entry.body.trim(),
    '',
    '-----',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function appendSupportReplyLog(message: string, entry: string) {
  if (message.includes(entry.trim())) {
    return message;
  }

  if (message.includes(SUPPORT_REPLY_LOG_HEADER)) {
    return `${message.trimEnd()}\n${entry}`;
  }

  return `${message.trimEnd()}${SUPPORT_REPLY_LOG_HEADER}${entry}`;
}
