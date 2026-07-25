import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  isAllowedImageType,
  MAX_IMAGE_BYTES,
  type StoredAttachment,
} from '@/lib/attachments';
import {
  appendSupportReplyLog,
  hasSupportLogIdempotencyKey,
} from '@/lib/support-reply-log';

const UUID_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, 'i');
const INBOUND_LOCAL_PART_PATTERN = new RegExp(
  `^ticket-(${UUID_SOURCE})-([a-f0-9]{20})$`,
  'i'
);
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_INBOUND_REPLY_CHARS = 20_000;

export type SupportInboundLogEntry = {
  receivedAt: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  receivedEmailId: string;
  webhookId: string;
  attachments?: StoredAttachment[];
};

export function buildSupportInboundReplyAddress(params: {
  ticketId: string;
  domain: string;
  secret: string;
}) {
  const ticketId = params.ticketId.trim().toLowerCase();
  const domain = normalizeInboundDomain(params.domain);
  if (!UUID_PATTERN.test(ticketId)) {
    throw new Error('Invalid support ticket ID');
  }
  if (!domain || !params.secret) {
    throw new Error('Support inbound email is not configured');
  }

  return `ticket-${ticketId}-${createTicketToken(ticketId, params.secret)}@${domain}`;
}

export function parseSupportInboundReplyAddress(params: {
  addresses: string[];
  domain: string;
  secret: string;
}) {
  const domain = normalizeInboundDomain(params.domain);
  if (!domain || !params.secret) return null;

  for (const value of params.addresses) {
    for (const address of extractEmailAddresses(value)) {
      const separatorIndex = address.lastIndexOf('@');
      const localPart = address.slice(0, separatorIndex);
      const addressDomain = address.slice(separatorIndex + 1);
      if (addressDomain !== domain) continue;

      const match = INBOUND_LOCAL_PART_PATTERN.exec(localPart);
      if (!match) continue;
      const ticketId = match[1].toLowerCase();
      const suppliedToken = match[2];
      const expectedToken = createTicketToken(ticketId, params.secret);
      if (safeTokenEqual(suppliedToken, expectedToken)) {
        return { ticketId, address };
      }
    }
  }

  return null;
}

export function extractMailboxAddress(value: string) {
  return extractEmailAddresses(value)[0] || '';
}

export function normalizeMailboxAddress(value: string) {
  return extractMailboxAddress(value).toLowerCase();
}

export function extractCustomerReplyText(params: {
  text?: string | null;
  html?: string | null;
}) {
  const source = params.text?.trim()
    ? params.text
    : htmlToPlainText(params.html || '');
  if (!source) return '';

  const normalized = source
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[^\S\n]+$/gm, '')
    .trim();
  const lines = normalized.split('\n');
  const cutoffIndex = lines.findIndex((line, index) =>
    isQuotedReplyBoundary(line, lines, index)
  );
  const reply = (cutoffIndex >= 0 ? lines.slice(0, cutoffIndex) : lines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (reply.length <= MAX_INBOUND_REPLY_CHARS) return reply;
  return `${reply.slice(0, MAX_INBOUND_REPLY_CHARS).trimEnd()}\n\n[20,000文字を超えたため、これ以降は省略されています]`;
}

export function buildSupportInboundLogEntry(entry: SupportInboundLogEntry) {
  const receivedAtJa = new Date(entry.receivedAt).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
  });
  const attachments = entry.attachments || [];

  return [
    `受信日時: ${receivedAtJa}`,
    '種別: 顧客返信',
    `送信者: ${entry.senderEmail}`,
    `宛先: ${entry.toEmail}`,
    `件名: ${entry.subject || '（件名なし）'}`,
    `Resend受信ID: ${entry.receivedEmailId}`,
    `Webhook ID: ${entry.webhookId}`,
    `重複防止キー: ${getSupportInboundIdempotencyKey(entry.receivedEmailId)}`,
    '',
    '本文:',
    entry.body.trim() || '（本文なし）',
    ...(attachments.length > 0
      ? [
          '',
          '添付画像:',
          ...attachments.map(
            (attachment) =>
              `![${attachment.name} (${formatBytes(attachment.size)})](${attachment.url})`
          ),
        ]
      : []),
    '',
    '-----',
  ].join('\n');
}

export function appendSupportInboundLog(
  message: string,
  entry: SupportInboundLogEntry
) {
  return appendSupportReplyLog(message, buildSupportInboundLogEntry(entry));
}

export function hasSupportInboundEmail(message: string, receivedEmailId: string) {
  return hasSupportLogIdempotencyKey(
    message,
    getSupportInboundIdempotencyKey(receivedEmailId)
  );
}

export function getSupportInboundIdempotencyKey(receivedEmailId: string) {
  return `inbound-email-${receivedEmailId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100)}`;
}

export function extractSupportInboundCustomerMessages(replyLog: string) {
  return replyLog
    .split(/\n-----\n?/)
    .filter((entry) => entry.includes('種別: 顧客返信'))
    .map((entry) => {
      const bodyMarker = '\n本文:\n';
      const bodyIndex = entry.indexOf(bodyMarker);
      return bodyIndex >= 0
        ? entry.slice(bodyIndex + bodyMarker.length).trim()
        : '';
    })
    .filter(Boolean);
}

export function detectImageMimeType(bytes: Uint8Array) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)))
  ) {
    return 'image/gif';
  }
  return null;
}

export function validateInboundImageBytes(params: {
  bytes: Uint8Array;
  declaredMimeType: string;
  declaredSize?: number;
}) {
  if (
    (params.declaredSize || 0) > MAX_IMAGE_BYTES ||
    params.bytes.byteLength > MAX_IMAGE_BYTES
  ) {
    throw new Error('Inbound attachment exceeds the 4MB limit');
  }

  const declaredMimeType =
    params.declaredMimeType.trim().toLowerCase() === 'image/jpg'
      ? 'image/jpeg'
      : params.declaredMimeType.trim().toLowerCase();
  const detectedMimeType = detectImageMimeType(params.bytes);
  if (
    !detectedMimeType ||
    !isAllowedImageType(detectedMimeType) ||
    declaredMimeType !== detectedMimeType
  ) {
    throw new Error('Inbound attachment content does not match its image type');
  }

  return detectedMimeType;
}

function normalizeInboundDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    domain
  )
    ? domain
    : '';
}

function createTicketToken(ticketId: string, secret: string) {
  return createHmac('sha256', secret)
    .update(`acti-support-reply:${ticketId}`)
    .digest('hex')
    .slice(0, 20);
}

function safeTokenEqual(supplied: string, expected: string) {
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function extractEmailAddresses(value: string) {
  return Array.from(value.matchAll(EMAIL_PATTERN), (match) =>
    match[0].toLowerCase()
  );
}

function isQuotedReplyBoundary(
  line: string,
  lines: string[],
  index: number
) {
  const value = line.trim();
  if (!value) return false;
  if (/^>/.test(value)) return true;
  if (/^On .+wrote:$/i.test(value)) return true;
  if (/^20\d{2}年.+(?:書きました|送信):?[：:]?$/.test(value)) return true;
  if (
    /^-{2,}\s*(?:Original Message|Forwarded message|元のメッセージ|転送メッセージ)\s*-{2,}$/i.test(
      value
    )
  ) {
    return true;
  }

  const nextLines = lines
    .slice(index + 1, index + 5)
    .map((candidate) => candidate.trim());
  return (
    /^(?:From|差出人):\s*/i.test(value) &&
    nextLines.some((candidate) => /^(?:Sent|送信日時):\s*/i.test(candidate)) &&
    nextLines.some((candidate) => /^(?:To|宛先):\s*/i.test(candidate))
  );
}

function htmlToPlainText(html: string) {
  return html
    .slice(0, 500_000)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '')
    .replace(
      /<[^>]+class=["'][^"']*(?:gmail_quote|yahoo_quoted)[^"']*["'][^>]*>[\s\S]*$/gi,
      ''
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value: string) => decodeCodePoint(value, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) =>
      decodeCodePoint(value, 16)
    );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeCodePoint(value: string, radix: number) {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? String.fromCodePoint(codePoint)
    : '';
}
