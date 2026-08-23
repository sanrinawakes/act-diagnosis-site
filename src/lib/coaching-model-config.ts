export const DEFAULT_COACHING_TEXT_MODEL = 'gemini-3.5-flash';
export const DEFAULT_COACHING_TEXT_THINKING_LEVEL = 'low' as const;
export const DEFAULT_COACHING_TEXT_TEMPERATURE = 0.7;
export const DEFAULT_COACHING_TEXT_TOP_P = 0.95;
export const DEFAULT_GEMINI_TEXT_TIMEOUT_MS = 22000;

export const COACHING_IMAGE_MODEL = 'gemini-3.5-flash';
export const COACHING_IMAGE_THINKING_LEVEL = 'minimal' as const;
export const COACHING_IMAGE_TEMPERATURE = 0.2;
export const COACHING_IMAGE_TOP_P = 0.8;
export const GEMINI_IMAGE_TIMEOUT_MS = 20000;

export type CoachingTextThinkingLevel = 'minimal' | 'low' | 'medium';

export type CoachingTextModelConfig = {
  model: string;
  thinkingLevel: CoachingTextThinkingLevel;
  temperature: number;
  topP: number;
  timeoutMs: number;
};

type CoachingModelEnvironment = {
  COACHING_TEXT_MODEL?: string;
  COACHING_TEXT_THINKING_LEVEL?: string;
  COACHING_TEXT_TEMPERATURE?: string;
  COACHING_TEXT_TOP_P?: string;
  GEMINI_TEXT_TIMEOUT_MS?: string;
};

export function getCoachingTextModelConfig(
  env: CoachingModelEnvironment = process.env as CoachingModelEnvironment
): CoachingTextModelConfig {
  return {
    model: env.COACHING_TEXT_MODEL?.trim() || DEFAULT_COACHING_TEXT_MODEL,
    thinkingLevel: parseThinkingLevel(env.COACHING_TEXT_THINKING_LEVEL),
    temperature: parseBoundedNumber(
      env.COACHING_TEXT_TEMPERATURE,
      DEFAULT_COACHING_TEXT_TEMPERATURE,
      0,
      2
    ),
    topP: parseBoundedNumber(
      env.COACHING_TEXT_TOP_P,
      DEFAULT_COACHING_TEXT_TOP_P,
      0,
      1
    ),
    timeoutMs: Math.round(
      parseBoundedNumber(
        env.GEMINI_TEXT_TIMEOUT_MS,
        DEFAULT_GEMINI_TEXT_TIMEOUT_MS,
        1000,
        55000
      )
    ),
  };
}

function parseThinkingLevel(
  value: string | undefined
): CoachingTextThinkingLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'minimal' || normalized === 'medium'
    ? normalized
    : DEFAULT_COACHING_TEXT_THINKING_LEVEL;
}

function parseBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}
