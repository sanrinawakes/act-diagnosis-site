/**
 * Shared AI coaching logic for web chat and messaging platforms (LINE, WhatsApp, etc.)
 */
import { getContextualizedPrompt } from '@/data/coaching-system-prompt';
import {
  buildGeminiParts,
  generateCoachingText,
} from '@/lib/coaching-gemini';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are an ACT (Awakening Consciousness Type) coaching AI designed to help users understand themselves better through personalized coaching.

You provide compassionate, insightful coaching based on the user's ACT type diagnosis. Your approach includes:
1. Deep empathy and understanding of the user's situation
2. Insightful observations about patterns and possibilities they might not see
3. Actionable next steps and practical suggestions

Always communicate in Japanese, with respect and curiosity. Help users understand their strengths, growth areas, and pathways to higher consciousness levels.`;

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
    : DEFAULT_SYSTEM_PROMPT;

  const result = await generateCoachingText({
    systemPrompt,
    historyMessages: history,
    lastUserParts: buildGeminiParts(userMessage, []),
  });

  return result.text;
}
