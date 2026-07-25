import {
  parseSupportTechnicalContext,
  type SupportTechnicalContext,
} from '@/lib/support-ticket-context';
import {
  SUPPORT_REPLY_LOG_HEADER,
  SUPPORT_TECHNICAL_CONTEXT_HEADER,
} from '@/lib/support-message-markers';

export { SUPPORT_REPLY_LOG_HEADER };

export type SupportReplyLogEntry = {
  sentAt: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  deliveryStatus: 'sent' | 'failed';
  resendId?: string;
  error?: string;
  idempotencyKey?: string;
  automationRunId?: string;
  evidence?: string;
};

export type SupportAutomationNoteEntry = {
  recordedAt: string;
  automationRunId: string;
  idempotencyKey: string;
  status: 'claimed' | 'investigating' | 'decision_required' | 'retry';
  note: string;
};

export function splitSupportMessage(message: string) {
  const replyMarkerIndex = message.indexOf(SUPPORT_REPLY_LOG_HEADER);
  const contextMarkerIndex = message.indexOf(SUPPORT_TECHNICAL_CONTEXT_HEADER);
  const firstMarkerIndex = [replyMarkerIndex, contextMarkerIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstMarkerIndex === undefined) {
    return {
      customerMessage: message,
      replyLog: '',
      technicalContext: null as SupportTechnicalContext | null,
    };
  }

  let rawTechnicalContext = '';
  if (contextMarkerIndex >= 0) {
    const contextStart =
      contextMarkerIndex + SUPPORT_TECHNICAL_CONTEXT_HEADER.length;
    const contextEnd =
      replyMarkerIndex > contextMarkerIndex ? replyMarkerIndex : message.length;
    rawTechnicalContext = message.slice(contextStart, contextEnd).trim();
  }

  return {
    customerMessage: message.slice(0, firstMarkerIndex).trimEnd(),
    replyLog:
      replyMarkerIndex >= 0
        ? message.slice(replyMarkerIndex + SUPPORT_REPLY_LOG_HEADER.length).trim()
        : '',
    technicalContext: parseSupportTechnicalContext(rawTechnicalContext),
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
    entry.idempotencyKey ? `重複防止キー: ${entry.idempotencyKey}` : null,
    entry.automationRunId ? `自動処理ID: ${entry.automationRunId}` : null,
    entry.evidence ? `検証記録: ${entry.evidence}` : null,
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

export function buildSupportAutomationNoteEntry(
  entry: SupportAutomationNoteEntry
) {
  const recordedAtJa = new Date(entry.recordedAt).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
  });

  return [
    `記録日時: ${recordedAtJa}`,
    '種別: ACTI自動対応',
    `状態: ${entry.status}`,
    `自動処理ID: ${entry.automationRunId}`,
    `重複防止キー: ${entry.idempotencyKey}`,
    '',
    '記録:',
    entry.note.trim(),
    '',
    '-----',
  ].join('\n');
}

export function hasSupportReplyIdempotencyKey(message: string, key: string) {
  return message
    .split('\n-----\n')
    .some(
      (entry) =>
        entry.includes(`重複防止キー: ${key}`) &&
        entry.includes('送信結果: sent')
    );
}

export function hasSupportLogIdempotencyKey(message: string, key: string) {
  return message.includes(`重複防止キー: ${key}`);
}

export function getLatestSupportAutomationClaimRunId(message: string) {
  const claimPattern =
    /状態: claimed\n自動処理ID: ([A-Za-z0-9_-]{8,120})\n重複防止キー:/g;
  let latestRunId = '';

  for (const match of message.matchAll(claimPattern)) {
    latestRunId = match[1] || latestRunId;
  }

  return latestRunId || null;
}
