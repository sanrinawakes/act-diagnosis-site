/**
 * Shared AI coaching logic for web chat and messaging platforms (LINE, WhatsApp, etc.)
 */
import {
  getCoachingSystemPrompt,
  getContextualizedPrompt,
} from '@/data/coaching-system-prompt';
import {
  buildGeminiParts,
  generateCoachingText,
} from '@/lib/coaching-gemini';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Generate a coaching response from the AI
 * @param userMessage - The latest user message
 * @param history - Previous conversation messages (optional)
 * @param diagnosisCode - ACT diagnosis code (optional)
 * @returns The AI response text
 */
export async function generateCoachingResponse(
  userMessage: string,
  history: ConversationMessage[] = [],
  diagnosisCode?: string | null
): Promise<string> {
  const systemPrompt = diagnosisCode
    ? getContextualizedPrompt(diagnosisCode)
    : getCoachingSystemPrompt();

  const result = await generateCoachingText({
    systemPrompt,
    historyMessages: history,
    lastUserParts: buildGeminiParts(userMessage, []),
  });

  return result.text;
}
