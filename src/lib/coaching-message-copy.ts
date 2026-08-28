import { stripAttachmentMarkdown } from '@/lib/attachments';

export function getCopyableCoachingMessageText(content: string) {
  return stripAttachmentMarkdown(content).trim();
}
