import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getContextualizedPrompt } from '@/data/coaching-system-prompt';
import {
  generateCoachingProviderCandidate,
  type CoachingCandidateProvider,
} from '@/lib/coaching-provider-candidates';
import type { CoachingChatMessage } from '@/lib/coaching-gemini';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const ALLOWED_MODELS: Record<CoachingCandidateProvider, Set<string>> = {
  gemini: new Set(['gemini-3.5-flash']),
  openai: new Set(['gpt-5.6-luna', 'gpt-5.6-terra']),
  anthropic: new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-5']),
};
const DIAGNOSIS_CODE_PATTERN = /^[SMP][VMG][AME]-[1-6]$/;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_TOTAL_CHARS = 40_000;

export async function POST(request: NextRequest) {
  const configuredToken = process.env.PROVIDER_BENCHMARK_TOKEN;
  const suppliedToken = request.headers.get('x-provider-benchmark-token') || '';
  if (
    process.env.VERCEL_ENV === 'production' ||
    !configuredToken ||
    !tokensMatch(configuredToken, suppliedToken)
  ) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const validation = validateBody(await request.json());
    if (!validation.body) {
      return NextResponse.json(
        { error: validation.error || 'Invalid request' },
        { status: 400 }
      );
    }

    const result = await generateCoachingProviderCandidate({
      ...validation.body,
      systemPrompt: getContextualizedPrompt(validation.body.diagnosisCode),
    });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error) },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

function validateBody(input: unknown): {
  body?: {
    provider: CoachingCandidateProvider;
    model: string;
    diagnosisCode: string;
    messages: CoachingChatMessage[];
  };
  error?: string;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Invalid request body' };
  }
  const body = input as Record<string, unknown>;
  if (
    body.provider !== 'gemini' &&
    body.provider !== 'openai' &&
    body.provider !== 'anthropic'
  ) {
    return { error: 'Invalid provider' };
  }
  if (
    typeof body.model !== 'string' ||
    !ALLOWED_MODELS[body.provider].has(body.model)
  ) {
    return { error: 'Invalid model' };
  }
  if (
    typeof body.diagnosisCode !== 'string' ||
    !DIAGNOSIS_CODE_PATTERN.test(body.diagnosisCode)
  ) {
    return { error: 'Invalid diagnosis code' };
  }
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > MAX_MESSAGES
  ) {
    return { error: 'Invalid messages' };
  }

  let totalChars = 0;
  const messages: CoachingChatMessage[] = [];
  for (const item of body.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'Invalid message' };
    }
    const message = item as Record<string, unknown>;
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_CHARS
    ) {
      return { error: 'Invalid message' };
    }
    totalChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  if (
    totalChars > MAX_TOTAL_CHARS ||
    messages[messages.length - 1].role !== 'user'
  ) {
    return { error: 'Invalid messages' };
  }

  return {
    body: {
      provider: body.provider,
      model: body.model,
      diagnosisCode: body.diagnosisCode,
      messages,
    },
  };
}

function tokensMatch(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 1_500);
}
