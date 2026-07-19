import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ATTACHMENT_BUCKET,
  isAllowedImageType,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  type ChatImageAttachment,
  type InlineImageAttachment,
} from '@/lib/attachments';

export function validateChatAttachments(
  attachments: ChatImageAttachment[],
  userId: string | null
) {
  if (attachments.length > MAX_IMAGE_ATTACHMENTS) {
    return `画像は最大${MAX_IMAGE_ATTACHMENTS}枚まで添付できます。`;
  }

  for (const attachment of attachments) {
    if (!isAllowedImageType(attachment.mimeType)) {
      return '添付できる画像は JPG / PNG / WebP / GIF のみです。';
    }

    if ('data' in attachment) {
      if (!isValidBase64(attachment.data)) {
        return '画像データが不正です。画像を選び直してください。';
      }
      if (base64ByteSize(attachment.data) > MAX_IMAGE_BYTES) {
        return '画像1枚あたりの上限は4MBです。';
      }
      continue;
    }

    if (!userId) {
      return '画像を送るには再ログインしてください。';
    }
    const expectedPrefix = `chat/${userId}/`;
    if (
      !attachment.path.startsWith(expectedPrefix) ||
      attachment.path.includes('..') ||
      attachment.path.length > 600
    ) {
      return '画像の保存先が不正です。画像を選び直してください。';
    }
  }

  return '';
}

export async function resolveChatAttachments(
  attachments: ChatImageAttachment[],
  supabaseAdmin: SupabaseClient
): Promise<InlineImageAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if ('data' in attachment) return attachment;

      const { data, error } = await supabaseAdmin.storage
        .from(ATTACHMENT_BUCKET)
        .download(attachment.path);
      if (error || !data) {
        throw new Error(
          `ATTACHMENT_DOWNLOAD_FAILED: ${error?.message || 'empty file'}`
        );
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`ATTACHMENT_SIZE_INVALID: ${buffer.length}`);
      }

      return {
        name: attachment.name,
        mimeType: attachment.mimeType,
        data: buffer.toString('base64'),
      };
    })
  );
}

function isValidBase64(value: string) {
  const clean = value.replace(/\s/g, '');
  if (!clean || clean.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(clean);
}

function base64ByteSize(base64: string) {
  const clean = base64.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}
