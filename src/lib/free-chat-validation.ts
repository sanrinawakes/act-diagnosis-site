export const MAX_FREE_REQUEST_MESSAGES = 100;
export const MAX_FREE_MESSAGE_CHARS = 50_000;
export const MAX_FREE_TOTAL_CHARS = 200_000;

export type FreeChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export function validateFreeMessages(input: unknown): {
  messages?: FreeChatMessage[];
  error?: string;
} {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'メッセージを入力してください。' };
  }
  if (input.length > MAX_FREE_REQUEST_MESSAGES) {
    return { error: 'メッセージ数が多すぎます。' };
  }

  const messages: FreeChatMessage[] = [];
  let totalChars = 0;
  for (const inputMessage of input) {
    if (!inputMessage || typeof inputMessage !== 'object' || Array.isArray(inputMessage)) {
      return { error: 'メッセージ内容が正しくありません。' };
    }
    const message = inputMessage as Record<string, unknown>;
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      message.content.length > MAX_FREE_MESSAGE_CHARS
    ) {
      return { error: 'メッセージ内容が正しくありません。' };
    }
    totalChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  if (totalChars > MAX_FREE_TOTAL_CHARS) {
    return { error: '入力内容が長すぎます。' };
  }
  if (messages.at(-1)?.role !== 'user') {
    return { error: '最後のメッセージは利用者の入力にしてください。' };
  }

  return { messages };
}
