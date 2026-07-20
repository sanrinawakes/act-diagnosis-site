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

const IMAGE_OPTIMIZE_THRESHOLD_BYTES = 1024 * 1024;
const IMAGE_OPTIMIZE_TARGET_BYTES = 2 * 1024 * 1024;
const IMAGE_OPTIMIZE_MAX_DIMENSION = 2048;
const IMAGE_JPEG_QUALITIES = [0.86, 0.76, 0.66];

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

  const uploadOne = async (sourceFile: File) => {
    const file = await prepareChatImageForUpload(sourceFile);
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

  const attachments: StoredAttachment[] = [];
  for (const file of files) {
    attachments.push(await uploadOne(file));
  }
  return attachments;
}

export function shouldOptimizeChatImage(file: File) {
  return (
    file.type !== 'image/gif' &&
    file.size > IMAGE_OPTIMIZE_THRESHOLD_BYTES
  );
}

export async function prepareChatImageForUpload(file: File): Promise<File> {
  if (
    !shouldOptimizeChatImage(file) ||
    typeof document === 'undefined' ||
    typeof createImageBitmap !== 'function'
  ) {
    return file;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, IMAGE_OPTIMIZE_MAX_DIMENSION / longestSide);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    let smallestBlob: Blob | null = null;
    for (const quality of IMAGE_JPEG_QUALITIES) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      if (!blob) continue;
      if (!smallestBlob || blob.size < smallestBlob.size) {
        smallestBlob = blob;
      }
      if (blob.size <= IMAGE_OPTIMIZE_TARGET_BYTES) break;
    }

    if (!smallestBlob || smallestBlob.size >= file.size) return file;

    return new File([smallestBlob], replaceImageExtension(file.name, 'jpg'), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

function replaceImageExtension(name: string, extension: string) {
  const stem = name.replace(/\.[^.]+$/, '') || 'image';
  return `${stem}.${extension}`;
}
