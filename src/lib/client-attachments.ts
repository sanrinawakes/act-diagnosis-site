import {
  formatBytes,
  isAllowedImageType,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  type StoredAttachment,
} from '@/lib/attachments';

export type PendingImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

export function validatePendingImageFiles(currentCount: number, files: File[]) {
  if (currentCount + files.length > MAX_IMAGE_ATTACHMENTS) {
    return `画像は最大${MAX_IMAGE_ATTACHMENTS}枚まで添付できます。`;
  }

  for (const file of files) {
    if (!isAllowedImageType(file.type)) {
      return '添付できる画像は JPG / PNG / WebP / GIF のみです。';
    }

    if (file.size > MAX_IMAGE_BYTES) {
      return `画像1枚あたりの上限は${formatBytes(MAX_IMAGE_BYTES)}です。`;
    }
  }

  return null;
}

export async function uploadChatImageAttachments(
  files: File[],
  accessToken = ''
): Promise<StoredAttachment[]> {
  if (files.length === 0) {
    return [];
  }

  const uploadOne = async (file: File) => {
    const formData = new FormData();
    formData.append('purpose', 'chat');
    formData.append('attachments', file);

    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : undefined,
      body: formData,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || '画像のアップロードに失敗しました。');
    }

    const attachment = data.attachments?.[0] as StoredAttachment | undefined;
    if (!attachment?.path) {
      throw new Error('画像の保存先を確認できませんでした。');
    }
    return attachment;
  };

  return Promise.all(files.map(uploadOne));
}
