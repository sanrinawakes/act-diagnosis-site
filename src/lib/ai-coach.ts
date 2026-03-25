/**
 * Shared AI coaching logic for web chat and messaging platforms (LINE, WhatsApp, etc.)
 */
import { genAI } from '@/lib/openai';
import { getContextualizedPrompt } from '@/data/coaching-system-prompt';

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

  // Prepare conversation history for Gemini
  const geminiHistory = history.map((msg) => ({
    role: msg.role === 'assistant' ? ('model' as const) : ('user' as const),
    parts: [{ text: msg.content }],
  }));

  // Create Gemini model with system instruction
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
  });

  // Start chat with history
  const chat = model.startChat({
    history: geminiHistory,
  });

  // Send the user message
  const result = await chat.sendMessage(userMessage);
  const response = result.response;

  return (
    response.text() ||
    'すみません、応答に失敗しました。もう一度お試しください。'
  );
}
