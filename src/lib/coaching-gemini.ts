import { getGenAI } from '@/lib/openai';
import {
  stripAttachmentMarkdown,
  type InlineImageAttachment,
} from '@/lib/attachments';

export interface CoachingChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CoachingUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

type GeminiRole = 'user' | 'model';

type GeminiTextPart = { text: string };
type GeminiImagePart = { inlineData: { mimeType: string; data: string } };
type GeminiPart = GeminiTextPart | GeminiImagePart;

type GeminiHistoryItem = {
  role: GeminiRole;
  parts: GeminiTextPart[];
};

const RECENT_HISTORY_LIMIT = 18;
const SUMMARY_CHAR_LIMIT = 3600;
const GEMINI_TIMEOUT_MS = 55000;

export function getCoachingGeminiModel(systemPrompt: string) {
  return getGenAI().getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.78,
      topP: 0.92,
      maxOutputTokens: 2048,
    },
  });
}

export function prepareGeminiHistory(
  messages: CoachingChatMessage[]
): GeminiHistoryItem[] {
  const cleaned = messages
    .map((message) => ({
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      text:
        stripAttachmentMarkdown(message.content).trim() ||
        (message.role === 'user' ? '画像を添付しました。' : ''),
    }))
    .filter((message) => message.text);

  const recentMessages = cleaned.slice(-RECENT_HISTORY_LIMIT);
  const olderMessages = cleaned.slice(0, -RECENT_HISTORY_LIMIT);
  const history: GeminiHistoryItem[] = [];

  if (olderMessages.length > 0) {
    history.push({
      role: 'user',
      parts: [
        {
          text: [
            '以下はこれまでの会話の背景です。これは新しい依頼ではありません。',
            '直近のやり取りを最優先しつつ、流れを失わないための文脈としてだけ使ってください。',
            '',
            buildConversationSummary(olderMessages),
          ].join('\n'),
        },
      ],
    });
    history.push({
      role: 'model',
      parts: [
        {
          text: '承知しました。背景として踏まえ、直近の会話を優先して自然に返答します。',
        },
      ],
    });
  }

  const firstUserIndex = recentMessages.findIndex(
    (message) => message.role === 'user'
  );
  const recentFromUser =
    firstUserIndex >= 0 ? recentMessages.slice(firstUserIndex) : [];
  const normalized = normalizeAlternatingHistory(recentFromUser);

  return [...history, ...normalized];
}

export function buildGeminiParts(
  text: string,
  attachments: InlineImageAttachment[]
): GeminiPart[] {
  const parts: GeminiPart[] = [
    {
      text: text.trim() || '添付画像について見てください。',
    },
  ];

  attachments.forEach((attachment) => {
    parts.push({
      inlineData: {
        mimeType: attachment.mimeType,
        data: attachment.data,
      },
    });
  });

  return parts;
}

export async function generateCoachingText(params: {
  systemPrompt: string;
  historyMessages: CoachingChatMessage[];
  lastUserParts: GeminiPart[];
}) {
  const model = getCoachingGeminiModel(params.systemPrompt);
  const chat = model.startChat({
    history: prepareGeminiHistory(params.historyMessages),
  });

  const result = await withTimeout(
    chat.sendMessage(params.lastUserParts),
    GEMINI_TIMEOUT_MS
  );
  const response = result.response;
  const text =
    response.text() || 'すみません、応答に失敗しました。もう一度お試しください。';

  return {
    text,
    usage: getUsage(response),
  };
}

export function createJsonLineStream(params: {
  systemPrompt: string;
  historyMessages: CoachingChatMessage[];
  lastUserParts: GeminiPart[];
  onDone: (usage: CoachingUsage) => Promise<Record<string, unknown>>;
}) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = '';

      const write = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        const model = getCoachingGeminiModel(params.systemPrompt);
        const chat = model.startChat({
          history: prepareGeminiHistory(params.historyMessages),
        });
        const result = await withTimeout(
          chat.sendMessageStream(params.lastUserParts),
          GEMINI_TIMEOUT_MS
        );

        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (!text) continue;
          fullText += text;
          write({ type: 'chunk', text });
        }

        const response = await result.response;
        const usage = getUsage(response);
        const donePayload = await params.onDone(usage);

        if (!fullText.trim()) {
          fullText = 'すみません、応答に失敗しました。もう一度お試しください。';
          write({ type: 'chunk', text: fullText });
        }

        write({
          type: 'done',
          message: fullText,
          usage,
          ...donePayload,
        });
      } catch (error) {
        const isTimeout =
          error instanceof Error && error.message === 'GEMINI_TIMEOUT';
        console.error('Gemini stream error:', error);
        write({
          type: 'error',
          error: isTimeout
            ? '応答に時間がかかりすぎたため中断しました。もう一度お試しください。'
            : 'AIの応答生成に失敗しました。もう一度お試しください。',
        });
      } finally {
        controller.close();
      }
    },
  });
}

export function getStreamHeaders() {
  return {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  };
}

function normalizeAlternatingHistory(
  messages: Array<{ role: GeminiRole; text: string }>
): GeminiHistoryItem[] {
  const normalized: GeminiHistoryItem[] = [];

  messages.forEach((message) => {
    if (message.role === 'model' && normalized.length === 0) return;

    const previous = normalized[normalized.length - 1];
    if (previous?.role === message.role) {
      previous.parts[0].text = `${previous.parts[0].text}\n\n${message.text}`;
      return;
    }

    normalized.push({
      role: message.role,
      parts: [{ text: message.text }],
    });
  });

  if (normalized[normalized.length - 1]?.role === 'user') {
    normalized.push({
      role: 'model',
      parts: [{ text: '続けて聞かせてください。' }],
    });
  }

  return normalized;
}

function buildConversationSummary(
  messages: Array<{ role: GeminiRole; text: string }>
) {
  const text = messages
    .map((message) => {
      const label = message.role === 'user' ? 'ユーザー' : 'コーチ';
      return `${label}: ${message.text}`;
    })
    .join('\n');

  if (text.length <= SUMMARY_CHAR_LIMIT) return text;
  return text.slice(-SUMMARY_CHAR_LIMIT);
}

function getUsage(response: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}): CoachingUsage {
  return {
    prompt_tokens: response.usageMetadata?.promptTokenCount,
    completion_tokens: response.usageMetadata?.candidatesTokenCount,
    total_tokens: response.usageMetadata?.totalTokenCount,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('GEMINI_TIMEOUT')),
      timeoutMs
    );
  });

  return Promise.race([
    promise,
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}
