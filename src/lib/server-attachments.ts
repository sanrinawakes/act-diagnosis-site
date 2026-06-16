import { createClient } from '@supabase/supabase-js';
import {
  ATTACHMENT_BUCKET,
  fileExtensionFromMimeType,
  isAllowedImageType,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  sanitizeFileName,
  SIGNED_URL_EXPIRES_IN,
  type StoredAttachment,
} from '@/lib/attachments';

export type AttachmentUploadInput = {
  files: File[];
  folder: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

export function validateImageFiles(files: File[]) {
  if (files.length > MAX_IMAGE_ATTACHMENTS) {
    throw new Error(`画像は最大${MAX_IMAGE_ATTACHMENTS}枚まで添付できます。`);
  }

  for (const file of files) {
    if (!isAllowedImageType(file.type)) {
      throw new Error('添付できる画像は JPG / PNG / WebP / GIF のみです。');
    }

    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error('画像1枚あたりの上限は4MBです。');
    }
  }
}

export async function uploadImageAttachments({
  files,
  folder,
  supabaseUrl,
  serviceRoleKey,
}: AttachmentUploadInput): Promise<StoredAttachment[]> {
  validateImageFiles(files);

  if (files.length === 0) {
    return [];
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  await ensureAttachmentBucket(supabase);

  const uploaded: StoredAttachment[] = [];

  for (const file of files) {
    const extension = fileExtensionFromMimeType(file.type);
    const safeName = sanitizeFileName(file.name);
    const path = `${folder}/${crypto.randomUUID()}-${safeName}.${extension}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, buffer, {
        contentType: file.type,
        cacheControl: '31536000',
        upsert: false,
      });

    if (uploadError) {
      throw new Error(`画像の保存に失敗しました: ${uploadError.message}`);
    }

    const { data: signedData, error: signedError } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(path, SIGNED_URL_EXPIRES_IN);

    if (signedError || !signedData?.signedUrl) {
      throw new Error(`画像URLの作成に失敗しました: ${signedError?.message || 'unknown error'}`);
    }

    uploaded.push({
      name: safeName,
      url: signedData.signedUrl,
      path,
      mimeType: file.type,
      size: file.size,
    });
  }

  return uploaded;
}

async function ensureAttachmentBucket(supabase: any) {
  const { error: getError } = await supabase.storage.getBucket(ATTACHMENT_BUCKET);

  if (!getError) {
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(ATTACHMENT_BUCKET, {
    public: false,
    fileSizeLimit: MAX_IMAGE_BYTES,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  });

  if (createError && !createError.message.toLowerCase().includes('already exists')) {
    throw new Error(`添付画像用ストレージの準備に失敗しました: ${createError.message}`);
  }
}
