import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ATTACHMENT_BUCKET,
  isAllowedImageType,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  type ChatImageAttachment,
  type InlineImageAttachment,
} from '@/lib/attachments';

const ATTACHMENT_DOWNLOAD_ATTEMPT_TIMEOUT_MS = 5000;
const ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS = [250, 750];

type ResolveChatAttachmentsOptions = {
  attemptTimeoutMs?: number;
  retryDelaysMs?: number[];
  onRetry?: (details: {
    attachmentIndex: number;
    nextAttempt: number;
    error: unknown;
  }) => void;
};

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
  supabaseAdmin: SupabaseClient,
  options: ResolveChatAttachmentsOptions = {}
): Promise<InlineImageAttachment[]> {
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? ATTACHMENT_DOWNLOAD_ATTEMPT_TIMEOUT_MS;
  const retryDelaysMs =
    options.retryDelaysMs ?? ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS;

  return Promise.all(
    attachments.map(async (attachment, attachmentIndex) => {
      if ('data' in attachment) return attachment;

      let lastError: unknown = new Error('ATTACHMENT_DOWNLOAD_FAILED');
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
          return await downloadStoredAttachment({
            attachment,
            supabaseAdmin,
            timeoutMs: attemptTimeoutMs,
          });
        } catch (error) {
          lastError = error;
          if (
            error instanceof Error &&
            error.message.startsWith('ATTACHMENT_SIZE_INVALID')
          ) {
            throw error;
          }
          if (attempt >= retryDelaysMs.length) throw error;

          options.onRetry?.({
            attachmentIndex,
            nextAttempt: attempt + 2,
            error,
          });
          await delay(retryDelaysMs[attempt]);
        }
      }

      throw lastError;
    })
  );
}

async function downloadStoredAttachment({
  attachment,
  supabaseAdmin,
  timeoutMs,
}: {
  attachment: Extract<ChatImageAttachment, { path: string }>;
  supabaseAdmin: SupabaseClient;
  timeoutMs: number;
}): Promise<InlineImageAttachment> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const download = Promise.resolve(
      supabaseAdmin.storage
        .from(ATTACHMENT_BUCKET)
        .download(
          attachment.path,
          {},
          { signal: controller.signal, cache: 'no-store' }
        )
    ).then(async ({ data, error }) => {
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
    });

    return await Promise.race([
      download,
      new Promise<InlineImageAttachment>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('ATTACHMENT_LOAD_TIMEOUT'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
