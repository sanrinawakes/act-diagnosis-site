import {
  COACHING_MAX_OUTPUT_TOKENS,
  COACHING_RESPONSE_SPEED_INSTRUCTION,
  getCoachingGeminiModel,
  prepareGeminiHistory,
  type CoachingChatMessage,
  type CoachingUsage,
} from '@/lib/coaching-gemini';

export type CoachingCandidateProvider = 'gemini' | 'openai' | 'anthropic';

export interface CoachingCandidateResult {
  rawText: string;
  firstChunkMs: number | null;
  totalMs: number;
  complete: boolean;
  finishReason: string | null;
  usage: CoachingUsage;
}

export interface CoachingCandidateImage {
  mimeType: string;
  data: string;
}

const REQUEST_TIMEOUT_MS = 60_000;

export async function generateCoachingProviderCandidate(params: {
  provider: CoachingCandidateProvider;
  model: string;
  systemPrompt: string;
  messages: CoachingChatMessage[];
  images?: CoachingCandidateImage[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CoachingCandidateResult> {
  const timeoutMs = params.timeoutMs || REQUEST_TIMEOUT_MS;
  const providerCode = params.provider.toUpperCase();

  return withAbortDeadline<CoachingCandidateResult>(
    timeoutMs,
    `${providerCode}_TIMEOUT`,
    `${providerCode}_ABORTED`,
    params.signal,
    (signal) => {
      if (params.provider === 'gemini') {
        return runGemini(
          params.model,
          params.systemPrompt,
          params.messages,
          params.images || [],
          signal
        );
      }
      if (params.provider === 'openai') {
        return runOpenAI(
          params.model,
          params.systemPrompt,
          params.messages,
          params.images || [],
          signal
        );
      }
      return runAnthropic(
        params.model,
        params.systemPrompt,
        params.messages,
        params.images || [],
        signal
      );
    }
  );
}

async function runGemini(
  modelName: string,
  systemPrompt: string,
  messages: CoachingChatMessage[],
  images: CoachingCandidateImage[],
  signal: AbortSignal
) {
  const startedAt = Date.now();
  const history = prepareGeminiHistory(messages.slice(0, -1));
  const lastUserText = messages[messages.length - 1].content;
  const model = getCoachingGeminiModel(systemPrompt, modelName);
  const chat = model.startChat({ history });
  const result = await chat.sendMessageStream(
    [
      { text: lastUserText },
      ...images.map((image) => ({
        inlineData: { mimeType: image.mimeType, data: image.data },
      })),
    ],
    { signal }
  );
  let rawText = '';
  let firstChunkMs: number | null = null;

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (!text) continue;
    firstChunkMs ??= Date.now() - startedAt;
    rawText += text;
  }
  const response = await result.response;
  const finishReason = response.candidates?.[0]?.finishReason || null;
  const usageMetadata = response.usageMetadata as
    | (typeof response.usageMetadata & { thoughtsTokenCount?: number })
    | undefined;

  return {
    rawText,
    firstChunkMs,
    totalMs: Date.now() - startedAt,
    complete: finishReason === 'STOP',
    finishReason,
    usage: {
      prompt_tokens: usageMetadata?.promptTokenCount,
      completion_tokens: usageMetadata?.candidatesTokenCount,
      cached_tokens: usageMetadata?.cachedContentTokenCount,
      thoughts_tokens: usageMetadata?.thoughtsTokenCount,
      total_tokens: usageMetadata?.totalTokenCount,
    },
  };
}

async function runOpenAI(
  model: string,
  systemPrompt: string,
  messages: CoachingChatMessage[],
  images: CoachingCandidateImage[],
  signal: AbortSignal
) {
  const apiKey = requireEnv('OPENAI_API_KEY');
  const startedAt = Date.now();
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: `${systemPrompt}${COACHING_RESPONSE_SPEED_INSTRUCTION}`,
      input: messages.map((message, index) => ({
        role: message.role,
        content:
          images.length > 0 &&
          message.role === 'user' &&
          index === messages.length - 1
            ? [
                { type: 'input_text', text: message.content },
                ...images.map((image) => ({
                  type: 'input_image',
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                })),
              ]
            : message.content,
      })),
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
      max_output_tokens: Math.min(COACHING_MAX_OUTPUT_TOKENS, 1_024),
      stream: true,
    }),
    signal,
  });
  await assertOk(response, 'OpenAI');

  let rawText = '';
  let firstChunkMs: number | null = null;
  const completed = { response: null as Record<string, unknown> | null };
  await consumeSse(response, (event) => {
    if (event.type === 'response.output_text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (delta) {
        firstChunkMs ??= Date.now() - startedAt;
        rawText += delta;
      }
    }
    if (event.type === 'response.completed' && isRecord(event.response)) {
      completed.response = event.response;
    }
    if (event.type === 'response.failed') {
      throw new Error(`OpenAI response failed: ${JSON.stringify(event.error)}`);
    }
  });

  const completedResponse = completed.response;
  const responseStatus =
    completedResponse && typeof completedResponse.status === 'string'
      ? completedResponse.status
      : null;
  const usage =
    completedResponse && isRecord(completedResponse.usage)
      ? completedResponse.usage
      : {};

  return {
    rawText,
    firstChunkMs,
    totalMs: Date.now() - startedAt,
    complete: responseStatus === 'completed',
    finishReason: responseStatus,
    usage: {
      prompt_tokens: numberOrUndefined(usage.input_tokens),
      completion_tokens: numberOrUndefined(usage.output_tokens),
      total_tokens: numberOrUndefined(usage.total_tokens),
    },
  };
}

async function runAnthropic(
  model: string,
  systemPrompt: string,
  messages: CoachingChatMessage[],
  images: CoachingCandidateImage[],
  signal: AbortSignal
) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const startedAt = Date.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      system: `${systemPrompt}${COACHING_RESPONSE_SPEED_INSTRUCTION}`,
      messages: messages.map((message, index) => ({
        role: message.role,
        content:
          images.length > 0 &&
          message.role === 'user' &&
          index === messages.length - 1
            ? [
                ...images.map((image) => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: image.mimeType,
                    data: image.data,
                  },
                })),
                { type: 'text', text: message.content },
              ]
            : message.content,
      })),
      max_tokens: Math.min(COACHING_MAX_OUTPUT_TOKENS, 1_024),
      thinking: { type: 'disabled' },
      stream: true,
    }),
    signal,
  });
  await assertOk(response, 'Anthropic');

  let rawText = '';
  let firstChunkMs: number | null = null;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let finishReason: string | null = null;
  let stopped = false;

  await consumeSse(response, (event) => {
    if (event.type === 'message_start' && isRecord(event.message)) {
      if (isRecord(event.message.usage)) {
        inputTokens = numberOrUndefined(event.message.usage.input_tokens);
      }
    }
    if (event.type === 'content_block_delta' && isRecord(event.delta)) {
      const delta =
        event.delta.type === 'text_delta' && typeof event.delta.text === 'string'
          ? event.delta.text
          : '';
      if (delta) {
        firstChunkMs ??= Date.now() - startedAt;
        rawText += delta;
      }
    }
    if (event.type === 'message_delta') {
      if (isRecord(event.delta) && typeof event.delta.stop_reason === 'string') {
        finishReason = event.delta.stop_reason;
      }
      if (isRecord(event.usage)) {
        outputTokens = numberOrUndefined(event.usage.output_tokens);
      }
    }
    if (event.type === 'message_stop') stopped = true;
    if (event.type === 'error') {
      throw new Error(`Anthropic response failed: ${JSON.stringify(event.error)}`);
    }
  });

  return {
    rawText,
    firstChunkMs,
    totalMs: Date.now() - startedAt,
    complete: stopped && finishReason === 'end_turn',
    finishReason,
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined,
    },
  };
}

async function consumeSse(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void
) {
  if (!response.body) throw new Error('Streaming response body is missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        parseSseBlock(block, onEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim()) parseSseBlock(buffer, onEvent);
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseSseBlock(
  block: string,
  onEvent: (event: Record<string, unknown>) => void
) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return;
  const parsed: unknown = JSON.parse(data);
  if (isRecord(parsed)) onEvent(parsed);
}

async function assertOk(response: Response, provider: string) {
  if (response.ok) return;
  const body = (await response.text()).slice(0, 1_000);
  throw new Error(`${provider} HTTP ${response.status}: ${body}`);
}

async function withAbortDeadline<T>(
  timeoutMs: number,
  timeoutCode: string,
  abortCode: string,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let rejectParentAbort: ((error: Error) => void) | undefined;
  const parentAbort = new Promise<never>((_, reject) => {
    rejectParentAbort = reject;
  });
  const onParentAbort = () => {
    controller.abort(parentSignal?.reason);
    rejectParentAbort?.(new Error(abortCode));
  };

  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(timeoutCode));
      controller.abort();
    }, Math.max(1, timeoutMs));
  });

  try {
    return await Promise.race([
      operation(controller.signal),
      timeout,
      parentAbort,
    ]);
  } catch (error) {
    if (timedOut) throw new Error(timeoutCode);
    if (parentSignal?.aborted) throw new Error(abortCode);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    parentSignal?.removeEventListener('abort', onParentAbort);
    controller.abort();
  }
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function numberOrUndefined(value: unknown) {
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
