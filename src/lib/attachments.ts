export const ATTACHMENT_BUCKET = 'acti-attachments';
export const MAX_IMAGE_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const SIGNED_URL_EXPIRES_IN = 60 * 60 * 24 * 365 * 5;

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

export type StoredAttachment = {
  name: string;
  url: string;
  path?: string;
  mimeType: string;
  size: number;
};

export type InlineImageAttachment = {
  name: string;
  mimeType: string;
  data: string;
};

export function isAllowedImageType(mimeType: string) {
  return ALLOWED_IMAGE_TYPES.includes(mimeType);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function sanitizeFileName(fileName: string) {
  const normalized = fileName.normalize('NFKC').replace(/[\\/:*?"<>|#%{}[\]^~`]/g, '_');
  return normalized.replace(/\s+/g, '_').slice(0, 120) || 'attachment';
}

export function fileExtensionFromMimeType(mimeType: string) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export function formatAttachmentMarkdown(attachments: StoredAttachment[]) {
  if (attachments.length === 0) return '';

  return [
    '',
    '',
    '添付画像:',
    ...attachments.map((attachment) => {
      const label = `${attachment.name} (${formatBytes(attachment.size)})`;
      return `![${label}](${attachment.url})`;
    }),
  ].join('\n');
}

export function appendAttachmentMarkdown(content: string, attachments: StoredAttachment[]) {
  return `${content.trim()}${formatAttachmentMarkdown(attachments)}`.trim();
}

export function parseAttachmentMarkdown(content: string) {
  const attachments: Array<{ label: string; url: string }> = [];
  const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(content)) !== null) {
    attachments.push({
      label: match[1],
      url: match[2],
    });
  }

  const text = content
    .replace(/^添付画像:\s*$/gm, '')
    .replace(imagePattern, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, attachments };
}

export function stripAttachmentMarkdown(content: string) {
  return parseAttachmentMarkdown(content).text;
}
