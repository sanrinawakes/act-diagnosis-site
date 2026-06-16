import { GoogleGenerativeAI } from '@google/generative-ai';

let geminiClient: GoogleGenerativeAI | null = null;

export function getGenAI() {
  if (geminiClient) return geminiClient;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }

  geminiClient = new GoogleGenerativeAI(apiKey);
  return geminiClient;
}
