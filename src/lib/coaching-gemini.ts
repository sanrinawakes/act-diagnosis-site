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
const HISTORY_MESSAGE_CHAR_LIMIT = 1200;
const GEMINI_TIMEOUT_MS = 35000;
const GEMINI_RETRY_DELAYS_MS = [800, 1600];
const MAX_TOKENS_CONTINUATION_NOTICE =
  '\n\n（ここで自然に区切ります。続きが必要な場合は「続き」と送ってください。）';

const TYPE_SUMMARIES: Record<string, string> = {
  SVA: '思索探求者。理想や思想を深く掘り下げ、自分なりの真理を探す力があります。',
  SVM: '慎重な調整者。急がず丁寧に状況を見て、無理のないバランスを取る力があります。',
  SVE: '共感リーダー。人の気持ちを受け取りながら、あたたかく周囲を導く力があります。',
  SMA: '内省的戦略家。自分を深く見つめ、改善点を見つけて計画的に進む力があります。',
  SMM: '平和主義の調和者。場の空気を読み、穏やかに関係性を整える力があります。',
  SME: '感性豊かな癒し手。人の痛みや違和感に気づき、安心感を与える力があります。',
  SGA: '緻密な現実主義者。細部まで丁寧に見て、現実的に物事を整える力があります。',
  SGM: '安定志向のバランサー。安心できる土台を大切にし、着実に整える力があります。',
  SGE: '現場に強い共感実務家。人の気持ちを汲みながら、現場で実際に動ける力があります。',
  MVA: '理想現実の橋渡し人。理想と現実の両方を見ながら、接点を作る力があります。',
  MVM: 'バランス思考の調整役。全体を見渡し、偏りを整える力があります。',
  MVE: '感性とビジョンの共創者。未来像と感覚を結びつけ、新しい可能性を作る力があります。',
  MMA: '論理と実行の精密設計者。筋道を立てて考え、計画を形にする力があります。',
  MMM: '中心軸を持つ均衡型。自分の軸を保ちながら、周囲とのバランスを取る力があります。',
  MME: '穏やかなる共感調整者。落ち着いた共感力で、人と人の間を整える力があります。',
  MGA: '現実に強い着実実行者。現実的な判断で、必要なことを一歩ずつ進める力があります。',
  MGM: '堅実な安定構築者。長く続く仕組みや安心できる基盤を作る力があります。',
  MGE: '地に足ついた感情調整者。感情を受け止めつつ、現実的に整える力があります。',
  PVA: '革新的アイデアマン。新しい発想で可能性を広げ、人に刺激を与える力があります。',
  PVM: '現場志向の推進者。動きながら状況を前に進める力があります。',
  PVE: '熱意あふれる表現者。思いや感情を表現し、人を明るく動かす力があります。',
  PMA: '論理で切り拓く挑戦者。分析力と挑戦心で、困難を突破する力があります。',
  PMM: '行動する安定志向者。安定を大切にしながら、必要な行動を起こす力があります。',
  PME: '感情と創造の実験家。感情のエネルギーを創造や挑戦につなげる力があります。',
  PGA: '結果にこだわる実行者。目標を定め、結果に向けて力強く動く力があります。',
  PGM: '効率的な現実構築者。効率と現実性を重視し、形にしていく力があります。',
  PGE: '感情を動力にする達成者。気持ちの強さを行動力に変えて達成する力があります。',
};

const LEVEL_SUMMARIES: Record<string, string> = {
  '1': '今は安全や安心を重視しやすい段階です。小さく試せる行動から始めると進みやすくなります。',
  '2': '内側に葛藤が出やすい段階です。どちらかを否定せず、両方の思いを整理することが助けになります。',
  '3': '自分の価値観で判断し、自立して進もうとする段階です。自分の軸を大切にしながら、周囲と協力する視点を持つと広がります。',
  '4': '自分と周囲の調和を大切にできる段階です。遠慮しすぎず、自分の望みも丁寧に扱うことが成長につながります。',
  '5': '創造性や貢献意識が高まりやすい段階です。ビジョンを具体的な行動に落とすことで力が発揮されます。',
  '6': '広い視点で物事を捉えやすい段階です。大きな視野と日常の実践をつなげることが鍵になります。',
};

export function getCoachingGeminiModel(systemPrompt: string) {
  return getGenAI().getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.65,
      topP: 0.9,
      maxOutputTokens: 1536,
      // Gemini 2.5 Flash has thinking enabled by default. Coaching chat needs
      // low first-token latency more than deep reasoning, so disable it here.
      thinkingConfig: { thinkingBudget: 0 },
    } as any,
  });
}

export function prepareGeminiHistory(
  messages: CoachingChatMessage[]
): GeminiHistoryItem[] {
  const cleaned = messages
    .map((message) => ({
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      text: truncateHistoryText(
        stripAttachmentMarkdown(message.content).trim() ||
          (message.role === 'user' ? '画像を添付しました。' : '')
      ),
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
  const result = await runWithGeminiRetry(async () => {
    const model = getCoachingGeminiModel(params.systemPrompt);
    const chat = model.startChat({
      history: prepareGeminiHistory(params.historyMessages),
    });

    return withTimeout(
      chat.sendMessage(params.lastUserParts),
      GEMINI_TIMEOUT_MS
    );
  });
  const response = result.response;
  const text = response.text();

  if (!text.trim()) {
    throw new Error('GEMINI_EMPTY_RESPONSE');
  }

  return {
    text: appendContinuationNoticeIfNeeded(text, response),
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
        let response:
          | {
              candidates?: Array<{ finishReason?: string }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                totalTokenCount?: number;
              };
            }
          | undefined;

        await runWithGeminiRetry(async () => {
          const model = getCoachingGeminiModel(params.systemPrompt);
          const chat = model.startChat({
            history: prepareGeminiHistory(params.historyMessages),
          });
          const result = await withTimeout(
            chat.sendMessageStream(params.lastUserParts),
            GEMINI_TIMEOUT_MS
          );

          try {
            for await (const chunk of result.stream) {
              const text = chunk.text();
              if (!text) continue;
              fullText += text;
              write({ type: 'chunk', text });
            }
          } catch (streamError) {
            if (fullText.trim()) {
              throw new Error('GEMINI_PARTIAL_STREAM_INTERRUPTED');
            }
            throw streamError;
          }

          response = await result.response;

          if (!fullText.trim()) {
            throw new Error('GEMINI_EMPTY_RESPONSE');
          }
        });

        if (!response) {
          throw new Error('GEMINI_EMPTY_RESPONSE');
        }

        const usage = getUsage(response);
        if (isMaxTokensFinish(response)) {
          fullText = trimToNaturalContinuationBoundary(fullText);
          fullText += MAX_TOKENS_CONTINUATION_NOTICE;
          write({ type: 'chunk', text: MAX_TOKENS_CONTINUATION_NOTICE });
        }
        const donePayload = await params.onDone(usage);

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

        if (
          isTimeout ||
          (error instanceof Error && error.message === 'GEMINI_EMPTY_RESPONSE')
        ) {
          const fallbackText = buildTimeoutFallbackResponse(
            params.systemPrompt,
            params.lastUserParts
          );
          const donePayload = await params.onDone({});
          write({ type: 'chunk', text: fallbackText });
          write({
            type: 'done',
            message: fallbackText,
            usage: {},
            ...donePayload,
          });
          return;
        }

        write({
          type: 'error',
          error: 'AIの応答生成に失敗しました。もう一度お試しください。',
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

async function runWithGeminiRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        attempt >= GEMINI_RETRY_DELAYS_MS.length ||
        !shouldRetryGeminiError(error)
      ) {
        break;
      }

      await delay(GEMINI_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

function shouldRetryGeminiError(error: unknown) {
  if (error instanceof Error && error.message === 'GEMINI_TIMEOUT') {
    return false;
  }

  if (error instanceof Error && error.message === 'GEMINI_EMPTY_RESPONSE') {
    return true;
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0;

  if ([429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  return [
    '429',
    '500',
    '502',
    '503',
    '504',
    'overloaded',
    'temporarily unavailable',
    'try again',
    'fetch failed',
    'econnreset',
    'etimedout',
    'rate limit',
  ].some((keyword) => message.includes(keyword));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function truncateHistoryText(text: string) {
  if (text.length <= HISTORY_MESSAGE_CHAR_LIMIT) return text;
  return `${text.slice(0, HISTORY_MESSAGE_CHAR_LIMIT)}\n（長文のため一部省略）`;
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

function appendContinuationNoticeIfNeeded(
  text: string,
  response: { candidates?: Array<{ finishReason?: string }> }
) {
  return isMaxTokensFinish(response)
    ? `${trimToNaturalContinuationBoundary(text)}${MAX_TOKENS_CONTINUATION_NOTICE}`
    : text;
}

function trimToNaturalContinuationBoundary(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  if (endsAtNaturalBoundary(trimmed) && !hasDanglingMarkdown(trimmed)) {
    return trimmed;
  }

  const boundaryIndex = findLastNaturalBoundary(trimmed);
  if (boundaryIndex >= 80) {
    return cleanupTrailingMarkdown(trimmed.slice(0, boundaryIndex + 1));
  }

  const paragraphIndex = trimmed.lastIndexOf('\n\n');
  if (paragraphIndex >= 80) {
    return cleanupTrailingMarkdown(trimmed.slice(0, paragraphIndex));
  }

  return cleanupTrailingMarkdown(trimmed);
}

function endsAtNaturalBoundary(text: string) {
  return /[。！？!?）)]$/.test(text);
}

function findLastNaturalBoundary(text: string) {
  const boundaryChars = ['。', '！', '？', '!', '?'];
  return Math.max(...boundaryChars.map((char) => text.lastIndexOf(char)));
}

function hasDanglingMarkdown(text: string) {
  const boldMarkerCount = (text.match(/\*\*/g) || []).length;
  return boldMarkerCount % 2 === 1;
}

function cleanupTrailingMarkdown(text: string) {
  return text
    .replace(/\s+\*\*[^*\n]*$/g, '')
    .replace(/\*\*$/g, '')
    .replace(/[#*_`「『（(、,，:：-]+$/g, '')
    .trim();
}

function isMaxTokensFinish(response: {
  candidates?: Array<{ finishReason?: string }>;
}) {
  return response.candidates?.some(
    (candidate) => candidate.finishReason === 'MAX_TOKENS'
  );
}

function buildTimeoutFallbackResponse(
  systemPrompt: string,
  parts: GeminiPart[]
) {
  const diagnosisCode = extractDiagnosisCode(systemPrompt);
  const userText = extractTextFromParts(parts);
  const [typeCode, level] = diagnosisCode?.split('-') || [];
  const typeSummary = typeCode ? TYPE_SUMMARIES[typeCode] : null;
  const levelSummary = level ? LEVEL_SUMMARIES[level] : null;

  if (typeSummary || levelSummary) {
    return [
      'お待たせしました。まず短くお返しします。',
      diagnosisCode ? `あなたのタイプ「${diagnosisCode}」は、${typeSummary || '自分らしさを大切にしながら成長していくタイプです。'}` : typeSummary,
      levelSummary,
      userText.includes('特徴') || userText.includes('タイプ')
        ? '強みは、変化や人の気持ちに気づきやすいことです。まず「私はどう感じたか」を一言で置いてみると、次の行動が見えやすくなります。'
        : '今は、結論を急ぐより「何が一番引っかかっているか」を一言にするのがおすすめです。',
      '続ける場合は、気になる点を一つだけ送ってください。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    'お待たせしました。まず短くお返しします。',
    '今は、いちばん気になっていることを一文にするところから始めるのが良さそうです。',
    'その一文を送っていただければ、そこから一緒に整理します。',
  ].join('\n');
}

function extractDiagnosisCode(systemPrompt: string) {
  const match = systemPrompt.match(/診断コード:\s*([A-Z]{3}-[1-6])/);
  return match?.[1] || null;
}

function extractTextFromParts(parts: GeminiPart[]) {
  return parts
    .map((part) => ('text' in part ? part.text : ''))
    .join('\n')
    .trim();
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
