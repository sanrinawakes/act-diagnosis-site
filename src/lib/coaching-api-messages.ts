export type CoachingApiMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export function buildFallbackCoachingApiMessages(
  messages: CoachingApiMessage[],
  limit: number
) {
  if (limit <= 0) return [];

  return messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim()
    )
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}
