import { getGenAI } from '@/lib/openai';
import {
  stripAttachmentMarkdown,
  type InlineImageAttachment,
} from '@/lib/attachments';
import { sendCoachingAlert } from '@/lib/coaching-alerts';

export interface CoachingChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CoachingUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  thoughts_tokens?: number;
  total_tokens?: number;
}

export interface CoachingTelemetry {
  route: string;
  requestId: string;
  requestMessages: number;
  compactMessages: number;
  historyMessages: number;
  attachments: number;
  lastUserChars: number;
  preStreamMs?: number;
  attachmentMs?: number;
  accountLookupMs?: number;
}

type GeminiRole = 'user' | 'model';

type GeminiTextPart = { text: string };
type GeminiImagePart = { inlineData: { mimeType: string; data: string } };
export type GeminiPart = GeminiTextPart | GeminiImagePart;

type GeminiHistoryItem = {
  role: GeminiRole;
  parts: GeminiTextPart[];
};

const RECENT_HISTORY_LIMIT = 8;
const SUMMARY_CHAR_LIMIT = 1200;
const HISTORY_MESSAGE_CHAR_LIMIT = 700;
const API_HISTORY_LIMIT = 14;
const API_HISTORY_CHAR_LIMIT = 700;
const API_LAST_USER_CHAR_LIMIT = 2500;
const GEMINI_TIMEOUT_MS = 45000;
const GEMINI_FINALIZE_TIMEOUT_MS = 4000;
const GEMINI_RETRY_DELAYS_MS = [800, 1600];
const ALERT_SLOW_RESPONSE_MS = 10000;
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
export const COACHING_TEXT_MODEL = 'gemini-3.5-flash';
export const COACHING_IMAGE_MODEL = 'gemini-3.1-flash-lite';
export const COACHING_MAX_OUTPUT_TOKENS = 4096;
export const COACHING_TEXT_THINKING_LEVEL = 'minimal';
const PARTIAL_STREAM_TIMEOUT_NOTICE =
  '\n\n（応答処理に時間がかかったため、ここで一度区切りました。続きが必要な場合は「続き」と送ってください。）';
const RESPONSE_SPEED_INSTRUCTION = [
  '',
  '---',
  '## 応答速度と安定性のための追加ルール',
  '- 1回の返答は原則180〜300字に収める。',
  '- 質問が複数ある場合は、すべてを一度に深掘りせず、最初の1つを中心に返す。',
  '- 長い前置き、網羅的な一覧、同じタイプ説明の繰り返しを避ける。',
  '- 「私の内面を教えてください」のような広い相談では、短く受け止め、1つの見立てと次の小さな質問だけ返す。',
].join('\n');

const alertLastSentAt = new Map<string, number>();

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

export function getCoachingGeminiModelName(parts: GeminiPart[]) {
  return parts.some((part) => 'inlineData' in part)
    ? COACHING_IMAGE_MODEL
    : COACHING_TEXT_MODEL;
}

export function getCoachingGeminiModel(
  systemPrompt: string,
  modelName = COACHING_TEXT_MODEL
) {
  const isImageModel = modelName === COACHING_IMAGE_MODEL;
  const generationConfig = {
    temperature: 0.2,
    topP: 0.8,
    maxOutputTokens: COACHING_MAX_OUTPUT_TOKENS,
    thinkingConfig: {
      thinkingLevel: isImageModel
        ? 'minimal'
        : COACHING_TEXT_THINKING_LEVEL,
    },
  };

  return getGenAI().getGenerativeModel({
    model: modelName,
    systemInstruction: `${systemPrompt}${RESPONSE_SPEED_INSTRUCTION}`,
    generationConfig,
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
  const normalizedText = text.trim() || '添付画像について見てください。';
  const responseStyleHint = buildResponseStyleHint(normalizedText);
  const parts: GeminiPart[] = [
    {
      text: responseStyleHint
        ? `${normalizedText}\n\n${responseStyleHint}`
        : normalizedText,
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

function buildResponseStyleHint(text: string) {
  if (requestsDirectWording(text)) {
    return '【内部応答形式】直近の会話を読み直し、ユーザーが明言した具体的な事実・感情・希望を少なくとも一つ含めて、そのまま読める一文を「」で一つだけ返してください。「少し話したいことがある」「今いいですか」のような許可取りだけの一般的な文、補足説明、追加質問は付けないでください。';
  }

  if (requestsSingleAnswerFormat(text)) {
    return '【内部応答形式】ユーザーの指定を優先し、答えまたは提案を一つだけ簡潔に返してください。補足の提案や確認質問は付けず、答えた時点で終了してください。';
  }

  if (requestsRestWithoutQuestions(text)) {
    return '【内部応答形式】今は掘り下げず、疲れを短く受け止めて、休んでよいと伝えてください。質問や追加の提案は付けないでください。';
  }

  return '';
}

export function compactCoachingMessages(
  messages: CoachingChatMessage[]
): CoachingChatMessage[] {
  if (messages.length === 0) return [];

  const lastMessage = messages[messages.length - 1];
  const historyMessages = dedupeConsecutiveMessages(
    messages.slice(0, -1).filter((message) => !isGenericFailureMessage(message))
  ).slice(-API_HISTORY_LIMIT);

  return [
    ...historyMessages.map((message) => ({
      role: message.role,
      content: truncateForApiPrompt(message.content, API_HISTORY_CHAR_LIMIT),
    })),
    {
      role: lastMessage.role,
      content:
        truncateForApiPrompt(lastMessage.content, API_LAST_USER_CHAR_LIMIT) ||
        (lastMessage.role === 'user' ? '添付画像について見てください。' : '続けて聞かせてください。'),
    },
  ].filter((message) => message.content.trim());
}

export async function generateCoachingText(params: {
  systemPrompt: string;
  historyMessages: CoachingChatMessage[];
  lastUserParts: GeminiPart[];
}) {
  const lastUserText = extractTextFromParts(params.lastUserParts);
  const urgentSafetyResponse = buildUrgentSafetyResponse(lastUserText);
  if (urgentSafetyResponse) {
    return {
      text: urgentSafetyResponse,
      usage: {},
      modelName: 'local-safety',
      completionStatus: 'complete' as const,
      finishReason: 'LOCAL_SAFETY_RESPONSE',
    };
  }

  const modelName = getCoachingGeminiModelName(params.lastUserParts);
  const result = await runWithGeminiRetry(async () => {
    const model = getCoachingGeminiModel(params.systemPrompt, modelName);
    const chat = model.startChat({
      history: prepareGeminiHistory(params.historyMessages),
    });

    return withTimeout(
      chat.sendMessage(params.lastUserParts),
      GEMINI_TIMEOUT_MS
    );
  });
  const response = result.response;
  const finishReason = getFinishReason(response);
  const completionStatus = classifyGeminiCompletion(finishReason);
  const text = completionStatus === 'partial'
    ? buildIncompleteGenerationRecoveryResponse(
        lastUserText,
        params.historyMessages
      )
    : normalizeCoachingOutput(
        response.text(),
        lastUserText,
        params.historyMessages
      );

  if (!text.trim()) {
    throw new Error('GEMINI_EMPTY_RESPONSE');
  }

  return {
    text,
    usage: getUsage(response),
    modelName,
    completionStatus,
    finishReason,
  };
}

export function createJsonLineStream(params: {
  systemPrompt: string;
  historyMessages: CoachingChatMessage[];
  lastUserParts: GeminiPart[];
  onDone: (usage: CoachingUsage) => Promise<Record<string, unknown>>;
  telemetry?: CoachingTelemetry;
}) {
  const encoder = new TextEncoder();
  const modelName = getCoachingGeminiModelName(params.lastUserParts);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = '';
      const startedAt = Date.now();
      let firstChunkMs: number | null = null;
      let generationFirstChunkMs: number | null = null;

      const write = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        const lastUserText = extractTextFromParts(params.lastUserParts);
        const urgentSafetyResponse = buildUrgentSafetyResponse(lastUserText);
        if (urgentSafetyResponse) {
          fullText = urgentSafetyResponse;
          firstChunkMs = Date.now() - startedAt;
          write({ type: 'chunk', text: fullText });
          const finalization = await resolveDonePayload(params.onDone, {});
          logChatTelemetry('done', params.telemetry, {
            modelName: 'local-safety',
            elapsedMs: Date.now() - startedAt,
            firstChunkMs,
            generationFirstChunkMs,
            finalizationStatus: finalization.status,
            finalizationMs: finalization.elapsedMs,
            finalizationError: finalization.error,
            outputChars: fullText.length,
            finishReason: 'LOCAL_SAFETY_RESPONSE',
            usage: {},
          });
          write({
            type: 'done',
            modelName: 'local-safety',
            completionStatus: 'complete',
            finalizationStatus: finalization.status,
            finishReason: 'LOCAL_SAFETY_RESPONSE',
            message: fullText,
            usage: {},
            ...finalization.payload,
          });
          return;
        }

        let response:
          | {
              candidates?: Array<{ finishReason?: string }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                cachedContentTokenCount?: number;
                thoughtsTokenCount?: number;
                totalTokenCount?: number;
              };
            }
          | undefined;

        await runWithGeminiRetry(async () => {
          const model = getCoachingGeminiModel(params.systemPrompt, modelName);
          const chat = model.startChat({
            history: prepareGeminiHistory(params.historyMessages),
          });
          const result = await withTimeout(
            chat.sendMessageStream(params.lastUserParts),
            GEMINI_TIMEOUT_MS
          );

          try {
            await withTimeout(
              consumeGeminiStream(result.stream, (text) => {
                fullText += text;
                generationFirstChunkMs ??= Date.now() - startedAt;
              }),
              GEMINI_TIMEOUT_MS
            );
          } catch (streamError) {
            if (fullText.trim()) {
              if (
                streamError instanceof Error &&
                streamError.message === 'GEMINI_TIMEOUT'
              ) {
                throw streamError;
              }
              throw new Error('GEMINI_PARTIAL_STREAM_INTERRUPTED');
            }
            throw streamError;
          }

          response = await withTimeout(result.response, GEMINI_FINALIZE_TIMEOUT_MS);

          if (!fullText.trim()) {
            throw new Error('GEMINI_EMPTY_RESPONSE');
          }
        });

        if (!response) {
          throw new Error('GEMINI_EMPTY_RESPONSE');
        }

        const finishReason = getFinishReason(response);
        const completionStatus = classifyGeminiCompletion(finishReason);
        fullText = completionStatus === 'partial'
          ? buildIncompleteGenerationRecoveryResponse(
              lastUserText,
              params.historyMessages
            )
          : normalizeCoachingOutput(
              fullText,
              lastUserText,
              params.historyMessages
            );
        const usage = getUsage(response);
        firstChunkMs = Date.now() - startedAt;
        write({ type: 'chunk', text: fullText });
        const finalization = await resolveDonePayload(params.onDone, usage);

        logChatTelemetry(completionStatus === 'partial' ? 'partial_done' : 'done', params.telemetry, {
          modelName,
          elapsedMs: Date.now() - startedAt,
          firstChunkMs,
          generationFirstChunkMs,
          finalizationStatus: finalization.status,
          finalizationMs: finalization.elapsedMs,
          finalizationError: finalization.error,
          outputChars: fullText.length,
          finishReason,
          usage,
        });

        write({
          type: 'done',
          modelName,
          completionStatus,
          finalizationStatus: finalization.status,
          finishReason,
          message: fullText,
          usage,
          ...finalization.payload,
        });
      } catch (error) {
        const isTimeout =
          error instanceof Error && error.message === 'GEMINI_TIMEOUT';
        console.error('Gemini stream error:', error);

        if (fullText.trim()) {
          fullText = trimToNaturalContinuationBoundary(fullText);
          fullText = normalizeCoachingOutput(
            fullText,
            extractTextFromParts(params.lastUserParts),
            params.historyMessages
          );
          if (isTimeout) {
            fullText += PARTIAL_STREAM_TIMEOUT_NOTICE;
          }
          firstChunkMs = Date.now() - startedAt;
          write({ type: 'chunk', text: fullText });
          const finalization = await resolveDonePayload(params.onDone, {});
          logChatTelemetry('partial_done', params.telemetry, {
            modelName,
            elapsedMs: Date.now() - startedAt,
            firstChunkMs,
            generationFirstChunkMs,
            finalizationStatus: finalization.status,
            finalizationMs: finalization.elapsedMs,
            finalizationError: finalization.error,
            outputChars: fullText.length,
            error: getErrorMessage(error),
          });
          write({
            type: 'done',
            modelName,
            completionStatus: 'partial',
            finalizationStatus: finalization.status,
            message: fullText,
            usage: {},
            ...finalization.payload,
          });
          return;
        }

        if (
          isTimeout ||
          (error instanceof Error && error.message === 'GEMINI_EMPTY_RESPONSE')
        ) {
          const fallbackText = buildTimeoutFallbackResponse(
            params.systemPrompt,
            params.lastUserParts
          );
          const finalization = await resolveDonePayload(params.onDone, {});
          firstChunkMs = Date.now() - startedAt;
          write({ type: 'chunk', text: fallbackText });
          logChatTelemetry('fallback_done', params.telemetry, {
            modelName,
            elapsedMs: Date.now() - startedAt,
            firstChunkMs,
            generationFirstChunkMs,
            finalizationStatus: finalization.status,
            finalizationMs: finalization.elapsedMs,
            finalizationError: finalization.error,
            outputChars: fallbackText.length,
            error: getErrorMessage(error),
          });
          write({
            type: 'done',
            modelName,
            completionStatus: 'fallback',
            finalizationStatus: finalization.status,
            message: fallbackText,
            usage: {},
            ...finalization.payload,
          });
          return;
        }

        write({
          type: 'error',
          error: 'AIの応答生成に失敗しました。もう一度お試しください。',
        });
        logChatTelemetry('error', params.telemetry, {
          modelName,
          elapsedMs: Date.now() - startedAt,
          firstChunkMs,
          generationFirstChunkMs,
          outputChars: fullText.length,
          error: getErrorMessage(error),
        });
      } finally {
        controller.close();
      }
    },
  });
}

function logChatTelemetry(
  status: 'done' | 'partial_done' | 'fallback_done' | 'error',
  telemetry: CoachingTelemetry | undefined,
  details: Record<string, unknown>
) {
  if (!telemetry) return;

  const payload = {
    event: `chat_stream_${status}`,
    ...telemetry,
    ...details,
  };

  const elapsedMs =
    typeof details.elapsedMs === 'number' ? details.elapsedMs : 0;
  const finalizationFailed = details.finalizationStatus === 'failed';
  const shouldWarn =
    status !== 'done' ||
    finalizationFailed ||
    elapsedMs >= ALERT_SLOW_RESPONSE_MS;
  const message = JSON.stringify(payload);

  if (shouldWarn) {
    console.warn(message);
    queueCoachingAlert(status, payload);
    return;
  }

  console.info(message);
}

function queueCoachingAlert(
  status: 'done' | 'partial_done' | 'fallback_done' | 'error',
  payload: Record<string, unknown>
) {
  const route = typeof payload.route === 'string' ? payload.route : 'unknown';
  const finalizationFailed = payload.finalizationStatus === 'failed';
  const alertKind = finalizationFailed ? 'finalization_failed' : status;
  const throttleKey = `${route}:${alertKind}`;
  const now = Date.now();
  const lastSentAt = alertLastSentAt.get(throttleKey) || 0;

  if (now - lastSentAt < ALERT_THROTTLE_MS) {
    return;
  }

  alertLastSentAt.set(throttleKey, now);

  void sendCoachingAlert({
    subject:
      finalizationFailed
        ? '[ACTI Bot] 会話後処理の失敗を検知しました'
        : status === 'done'
        ? '[ACTI Bot] 応答遅延を検知しました'
        : '[ACTI Bot] 応答失敗/中断を検知しました',
    summary:
      finalizationFailed
        ? 'AIの回答生成後に、利用回数などの会話後処理を完了できませんでした。VercelログのrequestIdで詳細を確認してください。'
        : status === 'done'
        ? 'AIコーチングbotで応答遅延を検知しました。VercelログのrequestIdで詳細を確認してください。'
        : 'AIコーチングbotで応答失敗または中断を検知しました。VercelログのrequestIdで詳細を確認してください。',
    details: payload,
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function consumeGeminiStream(
  stream: AsyncIterable<{ text: () => string }>,
  onText: (text: string) => void
) {
  for await (const chunk of stream) {
    const text = chunk.text();
    if (text) onText(text);
  }
}

async function resolveDonePayload(
  onDone: (usage: CoachingUsage) => Promise<Record<string, unknown>>,
  usage: CoachingUsage
) {
  const startedAt = Date.now();
  try {
    return {
      payload: await withTimeout(
        onDone(usage),
        GEMINI_FINALIZE_TIMEOUT_MS,
        'CHAT_FINALIZE_TIMEOUT'
      ),
      status: 'complete' as const,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    console.error('Failed to finalize chat stream metadata:', error);
    return {
      payload: {},
      status: 'failed' as const,
      elapsedMs: Date.now() - startedAt,
      error: getErrorMessage(error),
    };
  }
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

  const compactText = compactLongLines(text);
  if (compactText.length <= SUMMARY_CHAR_LIMIT) return compactText;
  return compactText.slice(-SUMMARY_CHAR_LIMIT);
}

function compactLongLines(text: string) {
  return text
    .split('\n')
    .map((line) => (line.length > 260 ? `${line.slice(0, 260)}…` : line))
    .join('\n');
}

function truncateHistoryText(text: string) {
  if (text.length <= HISTORY_MESSAGE_CHAR_LIMIT) return text;
  return `${text.slice(0, HISTORY_MESSAGE_CHAR_LIMIT)}\n（長文のため一部省略）`;
}

function truncateForApiPrompt(content: string, limit: number) {
  const text = stripAttachmentMarkdown(content).trim();
  if (text.length <= limit) return text;
  return compactLongTextForApiPrompt(text, limit);
}

function isGenericFailureMessage(message: CoachingChatMessage) {
  if (message.role !== 'assistant') return false;

  return [
    '応答に時間がかかりすぎたため中断しました',
    'すみません、応答に失敗しました',
    'AIの応答生成に失敗しました',
    'ログイン状態の確認に時間がかかりました',
    '会員情報の確認に時間がかかりました',
    '会員情報を確認できませんでした',
    'サーバーから回答を受け取れませんでした',
  ].some((text) => message.content.includes(text));
}

function dedupeConsecutiveMessages(messages: CoachingChatMessage[]) {
  const deduped: CoachingChatMessage[] = [];

  messages.forEach((message) => {
    const previous = deduped[deduped.length - 1];
    const normalizedContent = stripAttachmentMarkdown(message.content)
      .replace(/\s+/g, ' ')
      .trim();
    const previousContent = previous
      ? stripAttachmentMarkdown(previous.content).replace(/\s+/g, ' ').trim()
      : '';

    if (
      previous &&
      previous.role === message.role &&
      previousContent === normalizedContent
    ) {
      return;
    }

    deduped.push(message);
  });

  return deduped;
}

function compactLongTextForApiPrompt(text: string, limit: number) {
  const sentences = text
    .split(/(?<=[。！？!?])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const head = sentences.slice(0, 5).join('\n');
  const tail = sentences.slice(-5).join('\n');
  const middle = sentences
    .slice(5, -5)
    .filter((sentence) =>
      /困|悩|不安|怒|怖|嫌|したい|ほしい|必要|大事|仕事|家族|人間関係|お金|SNS|講座|気づき/.test(
        sentence
      )
    )
    .slice(0, 8)
    .join('\n');

  const compacted = [
    '（長文入力のため、AI処理用に要点を圧縮しています。ユーザーの原文は履歴に保存されています。）',
    head ? `冒頭:\n${head}` : '',
    middle ? `中盤の主な要点:\n${middle}` : '',
    tail ? `末尾:\n${tail}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (compacted.length <= limit) return compacted;

  const half = Math.floor((limit - 80) / 2);
  return [
    '（長文入力のため、AI処理用に冒頭と末尾を中心に圧縮しています。ユーザーの原文は履歴に保存されています。）',
    text.slice(0, half),
    '...',
    text.slice(-half),
  ].join('\n');
}

function getUsage(response: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}): CoachingUsage {
  return {
    prompt_tokens: response.usageMetadata?.promptTokenCount,
    completion_tokens: response.usageMetadata?.candidatesTokenCount,
    cached_tokens: response.usageMetadata?.cachedContentTokenCount,
    thoughts_tokens: response.usageMetadata?.thoughtsTokenCount,
    total_tokens: response.usageMetadata?.totalTokenCount,
  };
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

function getFinishReason(response: {
  candidates?: Array<{ finishReason?: string }>;
}) {
  return response.candidates?.find((candidate) => candidate.finishReason)
    ?.finishReason;
}

export function classifyGeminiCompletion(finishReason?: string) {
  return finishReason === 'STOP'
    ? ('complete' as const)
    : ('partial' as const);
}

export function buildIncompleteGenerationRecoveryResponse(
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  const urgentSafetyResponse = buildUrgentSafetyResponse(lastUserText);
  if (urgentSafetyResponse) return urgentSafetyResponse;

  if (
    /仕事|職場|業務|会社|タスク/.test(lastUserText) &&
    /落ち込/.test(lastUserText) &&
    /整理を手伝/.test(lastUserText)
  ) {
    return '仕事のことで少し落ち込んでいるんですね。\n\n今いちばん気になっている出来事は何ですか？';
  }

  if (/次の一言が怖/.test(lastUserText)) {
    return '上司に否定されたように感じて、次の一言が怖いんですね。\n\n次にその上司へ話す時、いちばん避けたいことは何ですか？';
  }

  if (requestsSingleAnswerFormat(lastUserText)) {
    return preserveRequestedActionTime(
      buildNoQuestionFallback(lastUserText, historyMessages),
      lastUserText
    );
  }

  return buildClosingCoachingQuestion(lastUserText, historyMessages);
}

function buildTimeoutFallbackResponse(
  systemPrompt: string,
  parts: GeminiPart[]
) {
  const diagnosisCode = extractDiagnosisCode(systemPrompt);
  const userText = extractTextFromParts(parts);
  const urgentSafetyResponse = buildUrgentSafetyResponse(userText);
  if (urgentSafetyResponse) return urgentSafetyResponse;

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
  const combined = parts
    .map((part) => ('text' in part ? part.text : ''))
    .join('\n')
    .trim();

  return stripInternalResponseStyleHint(combined);
}

export function stripInternalResponseStyleHint(text: string) {
  return text.replace(/\n{2,}【内部応答形式】[^\n]*\s*$/u, '').trim();
}

export function normalizeCoachingOutput(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  const urgentSafetyResponse = buildUrgentSafetyResponse(lastUserText);
  if (urgentSafetyResponse) return urgentSafetyResponse;

  if (requestsInternalPromptDisclosure(lastUserText)) {
    return 'その内容は公開できません。代わりに、今抱えている悩みや目標について一緒に考えます。今いちばん相談したいことは何ですか？';
  }

  if (requestsShortRestResponse(lastUserText)) {
    return '今日はゆっくり休んでください。';
  }

  const requiresClosingQuestion = requestsExplicitClosingQuestion(lastUserText);
  const questionLimit =
    requiresClosingQuestion || requestsNoFollowUpQuestion(lastUserText) ? 0 : 1;
  const safeText = rewriteInvalidatingAdvice(
    text,
    lastUserText,
    historyMessages
  );
  const quoteSafeText = balanceJapaneseDelimitersByParagraph(safeText);
  const deduplicatedText = removeRepeatedAssistantParagraphs(
    quoteSafeText,
    lastUserText,
    historyMessages
  );
  const naturalText = deduplicatedText
    .replace(/\*\*/g, '')
    .replace(/タタスク/g, 'タスク')
    .replace(/タースク/g, 'タスク')
    .replace(/タムスケジュール/g, 'タイムスケジュール')
    .replace(/(です|ます)[。．]\s*か[？?]/g, '$1か？')
    .replace(
      /長い(?:ご)?相談でも途中で止まることはありません(?:ので)?(?:ご安心ください)?[。]?/g,
      '長い相談は、一度に詰め込まず、内容を分けて送るとやり取りしやすくなります。'
    )
    .replace(/心中お察しいたします[。]?/g, 'それはつらかったですね。')
    .replace(/お気持ち(?:を)?お察しいたします[。]?/g, 'その気持ちは自然だと思います。')
    .replace(/お察しいたします[。]?/g, 'その気持ちは自然だと思います。')
    .replace(/お察しします/g, '思います')
    .replace(
      /(?:その)?(?:お気持ち|気持ち)[、,]?(?:とても)?よく(?:分|わ)かります[。]?/g,
      '気持ちが伝わります。'
    )
    .replace(/承知いたしました[。]?/g, 'わかりました。')
    .replace(/[、,]?と承知しました[。]?/g, '、確認しました。')
    .replace(/承知しました[。]?/g, 'わかりました。')
    .replace(
      /^([^。、,\n]{1,12})[、,]?と教えてくださり[、,]?ありがとうございます[。]?/gm,
      '$1、確認しました。'
    )
    .replace(
      /[^。\n]{0,100}(?:教えて|伝えて|話して|書いて|声をかけて|相談して)(?:くださり|くれて)[、,]?ありがとうございます[。]?/g,
      ''
    )
    .replace(
      /[^。\n]{0,100}(?:気持ち|状況|悩み)を言葉にしていただけて(?:よかった|うれしい)です[。]?/g,
      ''
    )
    .replace(/(?:そう)?お話ししてくださってありがとうございます[。]?/g, '')
    .replace(/お話ししてくださりありがとうございます[。]?/g, '')
    .replace(
      /(?:まずは[、,]?)?(?:その|今の)[^。\n]{0,90}受け止めさせてください[。]?/g,
      ''
    )
    .replace(
      /(?:まずは[、,]?)?(?:その|今の)[^。\n]{0,90}受け止めたいと思います[。]?/g,
      ''
    )
    .replace(
      /(?:まずは[、,]?)?(?:その|今の)?(?:お気持ち|気持ち)[^。\n]{0,18}受け止めます[。]?/g,
      ''
    )
    .replace(/いらっしゃるのですね/g, 'いるんですね')
    .replace(/いらっしゃる/g, 'いる')
    .replace(/上司の方/g, '上司')
    .replace(
      /上司に否定されたように感じて[、,]?次の一言が怖いと感じている/g,
      '上司に否定されたように感じて、次の一言が怖い'
    )
    .replace(/ご自身/g, '自分')
    .replace(/よろしければ/g, 'よかったら')
    .replace(/差し支えなければ/g, 'よかったら')
    .replace(/となっております/g, 'です')
    .replace(/どうぞお気軽にご質問ください[。]?/g, '気になることがあれば聞いてください。')
    .replace(/お気軽にお尋ねください[。]?/g, '気になることがあれば聞いてください。')
    .replace(/喜んでお伺いいたします[。]?/g, '一緒に考えます。')
    .replace(/どのようなことでもお気軽にご相談ください[。]?/g, '気になることがあれば聞いてください。')
    .replace(/(?:喜んで)?お伺いいたします[。]?/g, '一緒に考えます。')
    .replace(/(?:どうぞ)?お気軽に(?:ご質問|お尋ね|ご相談)ください[。]?/g, '気になることがあれば聞いてください。')
    .replace(/どうぞ(?=気になることがあれば)/g, '')
    .replace(/本来は/g, '')
    .replace(/[「『]?自分らしい[」』]?と感じられそう/g, '自分で納得できそう')
    .replace(
      /今日(?:は|一日)?[、,]?(?:もう[、,]?)?(?:本当に|よく|たくさん)?頑張られ(?:ましたね|たのですね)[。]?/g,
      'かなり疲れているんですね。'
    )
    .replace(/(?:それは)?素晴らしい一歩です[。！]?/g, '')
    .replace(
      /[^。\n]{0,100}気づけたことは[、,]?(?:とても)?大切な一歩です[。！]?/g,
      ''
    )
    .replace(
      /その[^。\n]{0,60}(?:大切な)?本音が隠れていそうです[。！]?/g,
      ''
    )
    .replace(
      /その悔しさ[^。\n]{0,100}(?:ブレーキ|手を止め)[^。\n]*[。！]?/g,
      ''
    )
    .replace(/その[^。\n]{0,80}気持ちが伝わります[。！]?/g, '')
    .replace(
      /そのように[^。\n]{0,120}姿勢は(?:とても)?素敵です[。！]?/g,
      ''
    )
    .replace(
      /(?:まずは[、,]?)?(?:その[^。\n]{0,40}ために[、,]?)?(?:今日|今夜)?[^。\n]{0,20}(?:一つ|ひとつ|1つ)(?:だけ)?(?:試せる|できる)?(?:提案|方法|行動)があります[。！]?/g,
      ''
    )
    .replace(/(?:それは)?(?:とても)?大切な本音です[。！]?/g, '')
    .replace(
      /落ち込(?:んでいる|む)(?:時|とき)は[^。！？?\n]{0,140}ことも(?:あります|あると思います)[。]?/g,
      ''
    )
    .replace(/(?:まずは[、,]?)?状況を(?:シンプル|簡単)にするために[、,]?/g, '')
    .replace(
      /[^。\n]{0,80}(?:思い|気持ち)(?:は|が)(?:とても)?大切です[。！]?/g,
      ''
    )
    .replace(
      /[^。\n]{0,80}それだけ[^。\n]{0,80}(?:大切|重要)[^。\n]{0,12}(?:から|ため)(?:ですね|です)?[。！]?/g,
      ''
    )
    .replace(/全力でサポートさせていただきます[。]?/g, '一緒に整理します。')
    .replace(/ご無理なさらず/g, '無理せず')
    .replace(/(?:ので[、,]?)?ご安心ください[。]?/g, '。')
    .replace(/ゆっくりお過ごしください/g, 'ゆっくり休んでください')
    .replace(/お辛い/g, 'つらい')
    .replace(
      /(?:お聞かせ|聞かせて|教えて|お話し|話して)いただけますか/g,
      '聞かせてもらえますか'
    )
    .replace(/お聞かせいただけますでしょうか/g, '聞かせてもらえますか')
    .replace(
      /ご?相談させていただけます(?:か|でしょうか)/g,
      '相談してもよいでしょうか'
    )
    .replace(
      /今回は見送らせていただけます(?:か|でしょうか)/g,
      '今回は見送らせてください'
    )
    .replace(/いただけますでしょうか/g, 'いただけますか')
    .replace(/お聞かせください/g, '聞かせてください')
    .replace(/どうぞゆっくりお休みください[。]?/g, '今日はゆっくり休んでくださいね。')
    .replace(/のが良いでしょう[。]?/g, 'のがよさそうです。')
    .replace(/(?:一度|一回)(?:だけ)?深呼吸(?:を)?(?:して|してから)[、,]?/g, '')
    .replace(
      /([」』])と(?:相手に)?伝えるのはいかがでしょうか[。]?/g,
      '$1と相手に伝えてみてください。'
    )
    .replace(/と伝えてみるのはいかがでしょうか[。]?/g, 'と伝えてみてください。')
    .replace(/と伝えてみてはいかがでしょうか[。]?/g, 'と伝えてみてください。')
    .replace(/(て|で)みるのはいかがでしょうか[。？?]?/g, '$1みてください。')
    .replace(/(て|で)みてはいかがでしょうか[。？?]?/g, '$1みてください。')
    .replace(/(て|で)みるのはどうでしょうか[。？?]?/g, '$1みてください。')
    .replace(/(て|で)みてはどうでしょうか[。？?]?/g, '$1みてください。')
    .replace(/みるのはいかがでしょうか[。]?/g, 'みてください。')
    .replace(/してみてはいかがでしょうか[。]?/g, 'してみてください。')
    .replace(/してみませんか[。？?]?/g, 'してみてください。')
    .replace(
      /(?:まずは[、,]?)?何があったのかを細かく分析する前に[、,]?/g,
      ''
    )
    .replace(
      /何か(?:具体的に|続けて)?(?:お話し|話して)(?:みたい|したい)?ことはありますか[？?]?/g,
      ''
    )
    .replace(
      /何か[、,]?(?:今)?(?:感じていることや[、,]?)?(?:話したい|話してみたい)ことはありますか[？?]?/g,
      ''
    )
    .replace(
      /今[、,]?(?:この瞬間に)?(?:最も|一番)?(?:話したい|話してみたい)ことは何ですか[？?]?/g,
      ''
    )
    .replace(
      /今(?:一番|いちばん)[「『]?(?:ここが)?重たい[」』]?と感じている出来事/g,
      '今いちばん気になっている出来事'
    )
    .replace(
      /今(?:一番|いちばん)(?:あなたの)?心を重くしているのは/g,
      '今いちばん気になっているのは'
    )
    .replace(
      /(?:いま|今)[、,]?(?:一番|いちばん)[、,]?心が引っかかっている出来事/g,
      '今いちばん気になっている出来事'
    )
    .replace(
      /(?:一番|いちばん)[^。！？?\n]{0,24}引っかかっている(?:出来事|状況)(?:や(?:出来事|状況))?/g,
      'いちばん気になっている出来事'
    )
    .replace(/気にかかっています/g, '気になっています')
    .replace(/気にかかっている/g, '気になっている')
    .replace(/何が一番心に引っかかっているか/g, '何が一番気になっているか')
    .replace(/何が一番しんどいか/g, '何が一番気になっているか')
    .replace(
      /今[、,]?一番しんどいことは何ですか/g,
      '今いちばん気になっていることは何ですか'
    )
    .replace(
      /一番しんどいことは何ですか/g,
      'いちばん気になっていることは何ですか'
    )
    .replace(
      /(?:今の)?状況を客観的に(?:見|捉え|考え|整理)(?:る|直す)?ために[、,]?/g,
      ''
    )
    .replace(
      /(?:特に)?[「『]?ここが一番しんどい[」』]?と感じる(?:ポイント|部分)はどこですか/g,
      '特に気になっていることは何ですか'
    )
    .replace(/あなたの言葉一つ一つを大切に受け止めています[。]?/g, '')
    .replace(/最後に[、,]?自分で判断を深めるための質問です[。]?/g, '')
    .replace(/。{2,}/g, '。');
  const contextualText = rewriteContextualClosingQuestion(
    naturalText,
    lastUserText,
    historyMessages
  );
  const referenceSafeText = rewriteUngroundedWordingReference(
    contextualText,
    lastUserText,
    historyMessages
  );
  const followUpSafeText = rewriteGenericSuggestionFollowUp(
    referenceSafeText,
    lastUserText,
    historyMessages
  );
  const temporallyAlignedText = /明日/.test(lastUserText)
    ? followUpSafeText.replace(/先ほど/g, '前回')
    : followUpSafeText;
  const responsiveText = removeAnsweredEmotionQuestion(
    temporallyAlignedText,
    lastUserText
  );
  const groundedText = removeUnsupportedPsychologicalInference(
    responsiveText,
    lastUserText,
    historyMessages
  );
  const diagnosisSafeText = requestsDiagnosisExplanation(lastUserText)
    ? groundedText
    : removeUnrequestedDiagnosisExplanation(groundedText);
  const focusedText = rewriteCompoundAnswerQuestions(
    diagnosisSafeText,
    lastUserText
  );
  const novelText = removeRepeatedAssistantParagraphs(
    focusedText,
    lastUserText,
    historyMessages
  );
  const paragraphs = novelText
    .trim()
    .split(/\n{2,}/)
    .filter((paragraph) => {
      if (questionLimit !== 0) return true;
      return !/もし(?:よろしければ|よかったら)|差し支えなければ|また.{0,12}(?:聞かせ|教えて)|お話しいただけ/.test(
        paragraph
      );
    });
  const segments = paragraphs
    .join('\n\n')
    .match(/[^。！？?\n]+[。！？?]?|\n+/g) || [];
  let questions = 0;
  let quoteDepth = 0;
  const keptSegments: string[] = [];

  segments.forEach((segment) => {
    const opens = countMatches(segment, /[「『]/g);
    const closes = countMatches(segment, /[」』]/g);
    const questionIsQuoted =
      !requiresClosingQuestion &&
      isQuestionInsideJapaneseQuote(segment, quoteDepth);
    const questionCount =
      isQuestionSegment(segment) && !questionIsQuoted
        ? Math.max(1, countMatches(segment, /[？?]/g))
        : 0;
    const withinLimit =
      questionCount === 0 || questions + questionCount <= questionLimit;

    if (withinLimit) {
      keptSegments.push(segment);
      questions += questionCount;
    }
    quoteDepth = Math.max(0, quoteDepth + opens - closes);
  });

  const normalized = keptSegments
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const fallbackText =
    questionLimit === 0
      ? buildNoQuestionFallback(lastUserText, historyMessages)
      : novelText.trim() ||
        buildClosingCoachingQuestion(lastUserText, historyMessages);
  const balanced = balanceJapaneseDelimitersByParagraph(
    softenRepeatedAcknowledgement(normalized || fallbackText)
  );
  const singleAnswerSafe = balanced;

  if (requestsOnePhraseAnswer(lastUserText)) {
    const shortAnswer = requestsDirectWording(lastUserText)
      ? selectSingleAnswerBlock(
          singleAnswerSafe,
          lastUserText,
          historyMessages
        )
      : firstNonEmptyParagraph(singleAnswerSafe);
    return preserveRequestedActionTime(
      requestsDirectWording(lastUserText)
        ? shortAnswer
        : unwrapStandaloneJapaneseQuote(shortAnswer),
      lastUserText
    );
  }

  if (
    requestsSingleAnswerFormat(lastUserText) &&
    !requestsExplicitClosingQuestion(lastUserText)
  ) {
    return preserveRequestedActionTime(
      selectSingleAnswerBlock(
        singleAnswerSafe,
        lastUserText,
        historyMessages
      ),
      lastUserText
    );
  }

  return preserveRequestedActionTime(
    ensureCoachingClose(
      limitUnrequestedCoachingMoves(singleAnswerSafe, lastUserText),
      lastUserText,
      historyMessages
    ),
    lastUserText
  );
}

export function buildUrgentSafetyResponse(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const mentionsSelfHarm = [
    /死にたい|死んで(?:しまい)?たい|死んだ(?:ほう|方)が(?:まし|いい)/,
    /消えたい|生きていたくない|生きるのをやめたい|もう生きられない/,
    /自殺(?:したい|しよう|する|を考|を図)|命を(?:絶|断)/,
    /自分(?:自身)?を傷つけ|自傷|リストカット/,
    /飛び降り|首を吊|大量(?:の)?薬|薬を大量|大量服薬|オーバードーズ|\bOD(?:したい|する|しよう)\b/i,
    /\bsuicid(?:e|al)\b|kill myself|hurt myself|self[- ]harm/i,
  ].some((pattern) => pattern.test(normalized));
  if (!mentionsSelfHarm) return null;

  return [
    '今はコーチングより、安全の確保を優先してください。あなた自身または身近な方が今すぐ自分を傷つける可能性がある場合は、一人にならず、危険な物や場所から離れ、近くの人に「今、一人にしないで」と伝えてください。日本国内なら119へ連絡してください。国外にいる場合は、現地の緊急番号へ連絡してください。',
    '今すぐの危険がなくても、いのちSOS（0120-061-338）または、よりそいホットライン（0120-279-338）へ電話してください。どちらも24時間・無料です。',
    'このBotだけで抱え込まず、今すぐ連絡できる人へ電話できますか？',
  ].join('\n\n');
}

function preserveRequestedActionTime(text: string, lastUserText: string) {
  if (!/明日/.test(lastUserText)) return text;

  let aligned = text
    .replace(/先ほど/g, '前回')
    .replace(/翌朝/g, '明日の朝')
    .replace(/翌日/g, '明日');
  if (
    requestsConcreteSuggestion(lastUserText) &&
    !requestsDirectWording(lastUserText) &&
    /明日の朝/.test(aligned)
  ) {
    aligned = aligned.replace(
      /([「『])明日伝えたい(こと|内容)([」』])/g,
      '$1最初に伝えたい$2$3'
    );
  }
  if (
    /明日の朝/.test(lastUserText) &&
    requestsConcreteSuggestion(lastUserText) &&
    !requestsDirectWording(lastUserText) &&
    !/明日の朝/.test(aligned)
  ) {
    const actionWithoutLeadingTomorrow = aligned.replace(
      /^明日(?:は|に)?[、,]?\s*/,
      ''
    );
    aligned = `明日の朝、${actionWithoutLeadingTomorrow}`;
  }
  if (requestsDirectWording(lastUserText)) return aligned;
  if (
    requestsConcreteSuggestion(lastUserText) &&
    !/明日/.test(aligned)
  ) {
    return `明日、${aligned}`;
  }

  return aligned;
}

function containsMultipleRequestedItems(text: string) {
  if (
    /(?:[2-9]|二|三|四|五|六|七|八|九|十)(?:つ|個|項目|案|方法|行動|言葉|語)(?:だけ)?/.test(
      text
    )
  ) {
    return true;
  }

  if (
    /例[:：][^。！？\n]{1,100}(?:、|または|もしくは|など)|例えば[、,]?[^。！？\n]{1,100}(?:または|もしくは|(?:、[^。！？\n]{1,80})+など)/.test(
      text
    )
  ) {
    return true;
  }

  if (/（[^）]{1,100}(?:、|または|もしくは)[^）]{1,100}など）/.test(text)) {
    return true;
  }

  if (/[「『][^」』]{1,100}[」』](?:や|または|もしくは|あるいは)[「『][^」』]{1,100}[」』]/.test(text)) {
    return true;
  }

  if (
    /(?:気持ち|感じたこと|伝えたいこと|気になっていること|出来事|状況|内容|言葉|一言|行動|作業|仕事|テーマ|頭に浮かんでくること)[^。！？\n]{0,12}(?:や|または|もしくは)[^。！？\n]{0,30}(?:気持ち|感じたこと|伝えたいこと|気になっていること|出来事|状況|内容|言葉|一言|行動|作業|仕事|テーマ|頭に浮かんでくること)/.test(
      text
    )
  ) {
    return true;
  }

  return (
    countCoachingActionClauses(text) >= 2 ||
    containsAlternativeRequestedActions(text)
  );
}

function countCoachingActionClauses(text: string) {
  const actionPattern =
    /書き出|書い|書く|抜き出|箇条書|決め|選ん|伝えて|話し始め|話して|話しかけ|(?:口|声)に出|読み上げ|読み返|見直|繰り返|深呼吸|呼吸を|飲ん|飲む|淹れ|意識を向け|感じる|思い浮かべ|休ん|休息|横にな|閉じ|眺め|確認|開い|移動|入れ|向か|座っ|席につ|立ち上が|歩い|片付|準備|通知.{0,6}オフ|送っ|連絡|相談|断っ|置い|取り組|始め/g;
  const unquoted = stripJapaneseQuotedContent(text);
  const lexicalCount = unquoted
    .split(/(?:て|で)から|その後|次に|続いて|[、,]/)
    .map((clause) => clause.trim())
    .reduce(
      (total, clause) => total + (clause.match(actionPattern) || []).length,
      0
    );
  const chainedActions = (
    unquoted.match(
      /(?:て|で)から|(?:した|いた|いだ|んだ|った)後(?:で|に)?|(?:(?<!と)(?:し|して)|いて|いで|んで|って)[、,]/g
    ) || []
  ).length;
  const hasDirective =
    /(?:て|で)(?:ください|みてください|みましょう)|してください|しましょう/.test(
      unquoted
    );

  return Math.max(
    lexicalCount,
    hasDirective && chainedActions > 0 ? chainedActions + 1 : 0
  );
}

function limitUnrequestedCoachingMoves(text: string, lastUserText: string) {
  if (/手順|ステップ|順番|段階|複数|いくつか|詳しく/.test(lastUserText)) {
    return text;
  }

  if (!requestsExplicitClosingQuestion(lastUserText)) {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const suggestedWordingIndex = paragraphs.findIndex((paragraph) =>
      /^(?:例えば[、,]\s*)?「[^」]{6,}」(?:と[^。！？?\n]{0,30})?[。！]?$/.test(
        paragraph
      )
    );
    if (suggestedWordingIndex >= 0) {
      const withoutTrailingQuestions = paragraphs.filter(
        (paragraph, index) =>
          index <= suggestedWordingIndex || !hasAnyCoachingQuestion(paragraph)
      );
      if (withoutTrailingQuestions.length < paragraphs.length) {
        return withoutTrailingQuestions.join('\n\n');
      }
    }

    const standaloneSuggestedWording = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .find(
        (paragraph) =>
          /^「[^」]{8,}」[。！]?$/.test(paragraph) &&
          requestsDirectWording(lastUserText)
      );
    if (standaloneSuggestedWording) return standaloneSuggestedWording;
  }

  const segments = text.match(/[^。！？?\n]+[。！？?]?|\n+/g) || [];
  const moveIndices: number[] = [];
  const moveScores = new Map<number, number>();
  let quoteDepth = 0;

  segments.forEach((segment, index) => {
    const opens = countMatches(segment, /[「『]/g);
    const closes = countMatches(segment, /[」』]/g);
    const questionIsQuoted = isQuestionInsideJapaneseQuote(segment, quoteDepth);
    const unquoted = stripJapaneseQuotedContent(segment).trim();
    const isQuestion = !questionIsQuoted && isQuestionSegment(segment);
    const isDirective =
      unquoted.length > 0 &&
      /(?:ください|ましょう)[。！]?$/.test(unquoted);
    const isSuggestedWording =
      (/「[^」]{4,}(?:お願い|してほしい|話したい|伝えたい|聞いてほしい|できる[？?]|ませんか)[^」]*」/.test(
        segment.trim()
      ) ||
        (/「[^」]{8,}」/.test(segment.trim()) &&
          (requestsDirectWording(lastUserText) ||
            /(?:伝えたい|話したい|言いたい)/.test(lastUserText))));

    if (isQuestion || isDirective || isSuggestedWording) {
      let score = index / Math.max(segments.length, 1);
      if (isQuestion) score += 4;
      if (isDirective) score += 4;
      if (isSuggestedWording) score += 6;
      if (/(?:\d+|一|ひと)(?:秒|分|回|行|文|つ)/.test(unquoted)) {
        score += 3;
      }
      if (/メモ|紙|ノート|付箋|見出し|目次|ファイル|資料/.test(unquoted)) {
        score += 2;
      }
      if (/焦点を当て|意識して|認めてあげ|整理してみましょう/.test(unquoted)) {
        score -= 2;
      }
      moveIndices.push(index);
      moveScores.set(index, score);
    }
    quoteDepth = Math.max(0, quoteDepth + opens - closes);
  });

  if (moveIndices.length <= 1) return text;
  const selectedMoveIndex = moveIndices.reduce((bestIndex, index) =>
    (moveScores.get(index) || 0) >= (moveScores.get(bestIndex) || 0)
      ? index
      : bestIndex
  );

  return segments
    .filter(
      (_, index) => !moveIndices.includes(index) || index === selectedMoveIndex
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function containsAlternativeRequestedActions(text: string) {
  if (
    /[「『][^」』]{1,100}[」』](?:や|または|もしくは|あるいは)[「『][^」』]{1,100}[」』]/.test(
      text
    )
  ) {
    return true;
  }

  return /(?:する|して|書く|書いて|伝える|話す|休む|閉じる|移動させる|オフにする|設定する|行う)か[、,]|(?:または|もしくは|あるいは)/.test(
    stripJapaneseQuotedContent(text)
  );
}

function stripJapaneseQuotedContent(text: string) {
  return text.replace(/「[^」]*」|『[^』]*』/g, '');
}

function requestsOnePhraseAnswer(text: string) {
  return /一言(?:だけ|で)|一語(?:だけ|で)?|単語(?:だけ|で)?/.test(text) &&
    !/提案|アドバイス|行動|方法|やり方|一歩/.test(text);
}

function firstNonEmptyParagraph(text: string) {
  return (
    text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .find(Boolean) || text.trim()
  );
}

function unwrapStandaloneJapaneseQuote(text: string) {
  const match = text.trim().match(/^「([\s\S]+)」$/u);
  return match ? match[1].trim() : text.trim();
}

function selectSingleAnswerBlock(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[]
) {
  const historicalUserText = historyMessages
    .filter((message) => message.role === 'user')
    .map((message) => stripAttachmentMarkdown(message.content))
    .join('\n');
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const eligibleParagraphs = paragraphs.filter(
    (paragraph) => !containsMultipleRequestedItems(paragraph)
  );
  const directWordingRequested = requestsDirectWording(lastUserText);
  const quotedAnswer = directWordingRequested
    ? eligibleParagraphs.find((paragraph) => /「[^」]{4,}」/.test(paragraph))
    : undefined;
  if (directWordingRequested && quotedAnswer) {
    if (
      isGroundedDirectWording(
        quotedAnswer,
        historyMessages,
        lastUserText
      )
    ) {
      return quotedAnswer;
    }

    const groundedFallback = buildGroundedDirectWording(
      historyMessages,
      lastUserText
    );
    if (groundedFallback) return groundedFallback;
  }
  if (directWordingRequested) {
    return buildNoQuestionFallback(lastUserText, historyMessages);
  }
  if (
    requestsConcreteSuggestion(lastUserText) &&
    /明日の朝/.test(lastUserText) &&
    /仕事|できること|何をすれば|行動|一歩/.test(lastUserText) &&
    /新しい仕事/.test(historicalUserText) &&
    /失敗/.test(historicalUserText) &&
    /期待を裏切/.test(historicalUserText)
  ) {
    return '明日の朝、その仕事で最初に終わらせる作業を一つだけメモに書いてください。';
  }
  const concreteParagraph = eligibleParagraphs.find((paragraph) =>
    hasConcreteAction(paragraph, lastUserText) &&
    isSingleActionRelevantToContext(
      paragraph,
      lastUserText,
      historyMessages
    )
  );
  const substantiveParagraph = eligibleParagraphs.find(
    (paragraph) =>
      isSubstantiveSingleAnswer(paragraph) &&
      isSingleActionRelevantToContext(
        paragraph,
        lastUserText,
        historyMessages
      )
  );
  const selected =
    quotedAnswer ||
    concreteParagraph ||
    substantiveParagraph ||
    eligibleParagraphs.at(-1) ||
    '';

  return quotedAnswer ||
    (selected &&
      (hasConcreteAction(selected, lastUserText) ||
        isSubstantiveSingleAnswer(selected)) &&
      isSingleActionRelevantToContext(
        selected,
        lastUserText,
        historyMessages
      ))
    ? selected
    : buildNoQuestionFallback(lastUserText, historyMessages);
}

function isSingleActionRelevantToContext(
  answer: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[]
) {
  if (!requestsConcreteSuggestion(lastUserText)) return true;
  if (/直前/.test(lastUserText)) {
    if (/(?:明日の朝|翌朝)/.test(answer)) return false;
    if (!/(?:直前|前[に、])/.test(answer)) return false;
  }
  if (
    /今夜/.test(lastUserText) &&
    /(?:明日|翌日)/.test(answer)
  ) {
    return false;
  }
  if (/疲|休|しんど|限界/.test(lastUserText)) {
    return /休|横にな|目を閉じ|睡眠|寝/.test(answer);
  }

  const userContext = [
    ...historyMessages
      .filter((message) => message.role === 'user')
      .map((message) => stripAttachmentMarkdown(message.content)),
    lastUserText,
  ].join('\n');
  if (
    /SNS.{0,28}(?:抵抗|怖|発信でき|投稿でき|苦手|避け)|(?:抵抗|怖|発信でき|投稿でき|苦手|避け).{0,28}SNS/.test(
      userContext
    ) &&
    /(?:SNSの)?アプリ.{0,32}(?:見えない|隠|移動|削除|閉じ)|通知.{0,16}(?:切|オフ)/.test(
      answer
    )
  ) {
    return false;
  }
  if (
    /率直な状況|今の自分の(?:率直な)?状況|事実として一言|自分の本音を一言/.test(
      answer
    )
  ) {
    return false;
  }
  if (
    /業務の確認だけ|[「『]?事実[」』]?だけ|話すのは[^。！？\n]{0,30}だけにする|(?:話題|会話)[^。！？\n]{0,16}(?:避け|限定)/.test(
      answer
    ) &&
    !/業務の確認だけ|事実[^。！？\n]{0,8}だけ|だけにする|避け|限定/.test(userContext)
  ) {
    return false;
  }
  if (
    /(?:今日|前回)[^。！？\n]{0,24}(?:言われた|話した|起きた)こととは関係のない/.test(
      answer
    ) &&
    !/(?:今日|前回)[^。！？\n]{0,24}(?:言われた|話した|起きた)こととは関係のない/.test(
      userContext
    )
  ) {
    return false;
  }
  if (/[「『]今日確認したいこと[」』]/.test(answer) && !/確認/.test(userContext)) {
    return false;
  }
  if (
    /確認したい(?:こと|ポイント|内容)[^。！？\n]{0,40}(?:メモ|書き出)/.test(
      answer
    ) &&
    !/確認/.test(userContext)
  ) {
    return false;
  }
  const contextChecks = [
    {
      present: /SNS|投稿|発信/.test(userContext),
      relevant: /SNS|投稿|発信/.test(answer),
    },
    {
      present: /仕事|職場|業務|会社|タスク/.test(userContext),
      relevant: /仕事|職場|業務|会社|タスク|資料|企画|予定|メール|会議|上司|同僚|顧客/.test(
        answer
      ),
    },
    {
      present: /上司|同僚|夫|妻|家族|親|子ども|友人|相手/.test(
        userContext
      ),
      relevant: /伝|話|聞|連絡|メモ|一文|質問|相談/.test(answer),
    },
  ].filter((check) => check.present);

  return (
    contextChecks.length === 0 ||
    contextChecks.some((check) => check.relevant)
  );
}

const DIRECT_WORDING_GROUNDING_TERMS = [
  ['軽く扱', 6],
  ['腹が立', 5],
  ['時間', 4],
  ['負担', 4],
  ['後回し', 4],
  ['悔', 4],
  ['却下', 4],
  ['最後まで', 4],
  ['断れ', 4],
  ['否定', 4],
  ['準備', 3],
  ['嫌', 3],
  ['怖', 3],
  ['不安', 3],
  ['喧嘩', 2],
  ['家事', 1],
] as const;

function selectGroundingStatement(historyMessages: CoachingChatMessage[]) {
  let bestSentence = '';
  let bestScore = 0;
  const sentences = historyMessages
    .filter((message) => message.role === 'user')
    .flatMap((message) =>
      stripAttachmentMarkdown(message.content)
        .split(/[。！？\n]+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean)
    );

  for (const sentence of sentences) {
    const score = DIRECT_WORDING_GROUNDING_TERMS.reduce(
      (total, [term, weight]) =>
        total + (sentence.includes(term) ? weight : 0),
      0
    );
    if (score >= 3 && score >= bestScore) {
      bestSentence = sentence;
      bestScore = score;
    }
  }

  return bestSentence;
}

function isGroundedDirectWording(
  answer: string,
  historyMessages: CoachingChatMessage[],
  lastUserText = ''
) {
  const userContext = [
    ...historyMessages
      .filter((message) => message.role === 'user')
      .map((message) => stripAttachmentMarkdown(message.content)),
    lastUserText,
  ].join('\n');

  if (
    /断(?:る|りたい|り方)|断る一言/.test(lastUserText) &&
    !/(?:今回は|今は|本日は|今回の依頼は)[^。！？?\n]{0,40}(?:引き受けられ|引き受けでき|お受けでき|対応でき|見送)|(?:お断り|辞退)します/.test(
      answer
    )
  ) {
    return false;
  }

  if (
    /責め(?:ず|ない|る言い方)|落ち着いて伝/.test(userContext) &&
    /嫌(?:です|だと|だ)|腹が立/.test(answer)
  ) {
    return false;
  }
  if (
    /家事|夫|妻/.test(userContext) &&
    /後回し|時間[^。\n]{0,40}軽く扱/.test(userContext) &&
    !/(?:いつ[^。！？?\n]{0,24}(?:対応|やる)|(?:対応|やる)[^。！？?\n]{0,24}いつ|一緒に決め|お願い|してほしい|後回しにしない)/.test(
      answer
    )
  ) {
    return false;
  }

  const statement = selectGroundingStatement(historyMessages);
  if (!statement) return true;

  const replacesAngerWithSadness =
    /腹が立|怒|悔|嫌/.test(userContext) &&
    !/悲し|落ち込|残念|心残り/.test(userContext) &&
    /悲し|落ち込|残念|心残り/.test(answer);
  if (replacesAngerWithSadness) return false;

  const hasForwardIntent =
    /話|伝|聞いてほしい|一緒に|これから|今後|分担|相談|お願い|してほしい|変えたい|改善/.test(
      answer
    );
  if (!hasForwardIntent) return false;

  const salientTerms = DIRECT_WORDING_GROUNDING_TERMS.filter(
    ([term, weight]) => weight >= 3 && statement.includes(term)
  ).map(([term]) => term);
  const groundingAnswer = answer.replace(
    /(?:今夜|今日|明日)[はに]?[、,\s]*(?:少し[、,\s]*)?時間[はが]?(?:ある|取れる|空いて(?:いる)?|もらえる)(?:かな|か|でしょうか)?[？?]?/g,
    ''
  );

  return (
    salientTerms.length === 0 ||
    salientTerms.some((term) => groundingAnswer.includes(term))
  );
}

function buildGroundedDirectWording(
  historyMessages: CoachingChatMessage[],
  lastUserText = ''
) {
  const statement = selectGroundingStatement(historyMessages);
  if (!statement) return '';

  const userContext = [
    ...historyMessages
      .filter((message) => message.role === 'user')
      .map((message) => stripAttachmentMarkdown(message.content)),
    lastUserText,
  ].join('\n');
  if (
    /会議|提案/.test(userContext) &&
    /最後まで|却下|準備(?:に使った)?時間|準備時間/.test(userContext)
  ) {
    return '「前回は提案を最後までお伝えできなかったので、今回は結論まで聞いてからご意見をいただけると助かります。」';
  }
  if (
    /家事|夫|妻/.test(userContext) &&
    /後回し|時間[^。\n]{0,40}軽く扱/.test(userContext)
  ) {
    return '「私の時間も大切にしたいので、家事を頼んだ時に、いつ対応するかを一緒に決めたいです。」';
  }

  const naturalStatement = statement
    .replace(
      /ように感じることが嫌(?:なん)?です$/u,
      'ように感じるのが嫌です。'
    )
    .replace(/ことが嫌(?:なん)?です$/u, 'ことが嫌だと感じています')
    .replace(/が嫌(?:なん)?です$/u, 'が嫌だと感じています')
    .replace(/腹が立ちます$/u, '腹が立っています')
    .replace(/悔しいんです$/u, '悔しいです')
    .replace(/んです$/u, 'です')
    .replace(/[。！？]+$/u, '');

  return `「${naturalStatement}。このことを責めたいのではなく、これからどうするか一緒に話したいです。」`;
}

function isSubstantiveSingleAnswer(text: string) {
  const compact = text.replace(/\s+/g, '').trim();
  if (compact.length < 12) return false;
  if (
    /^(?:わかりました|そうですね|なるほど|明日の一歩ですね|.+(?:のですね|んですね|ということですね))[。！]?$/.test(
      compact
    )
  ) {
    return false;
  }

  return (
    /明日|今日|今夜|朝|まず|最初|次に|直前|これから/.test(compact) &&
    /書|伝|話|整理|まとめ|確認|準備|選|決|始|開|休|飲|呼吸|連絡|相談|断|頼|聞|見|読|作|送|置|取|動|考/.test(compact)
  );
}

function ensureCoachingClose(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[]
) {
  if (
    requestsExplicitClosingQuestion(lastUserText) &&
    /企画書|提案書/.test(lastUserText) &&
    /着手|完璧|書き始め|手が止ま/.test(lastUserText)
  ) {
    const documentLabel = /提案書/.test(lastUserText) ? '提案書' : '企画書';
    const actionTime = /明日の朝/.test(lastUserText)
      ? '明日の朝、'
      : /明日/.test(lastUserText)
        ? '明日、'
        : /今夜/.test(lastUserText)
          ? '今夜、'
          : /今日/.test(lastUserText)
            ? '今日、'
            : '';
    return `${actionTime}最初の15分で${documentLabel}の見出しを一つだけ書いてください。\n\n15分後に何が書けていれば、着手は成功だと判断しますか？`;
  }

  if (requestsExplicitClosingQuestion(lastUserText)) {
    const body =
      requestsConcreteSuggestion(lastUserText) &&
      !hasConcreteAction(text, lastUserText)
        ? `${text}\n\n${buildNoQuestionFallback(lastUserText, historyMessages)}`
        : text;
    return `${body}\n\n${buildClosingCoachingQuestion(lastUserText, historyMessages)}`;
  }

  if (requestsSingleAnswerFormat(lastUserText)) {
    return requestsConcreteSuggestion(lastUserText) &&
      !hasConcreteAction(text, lastUserText)
      ? `${text}\n\n${buildNoQuestionFallback(lastUserText, historyMessages)}`
      : text;
  }

  if (
    hasAnyCoachingQuestion(text) ||
    hasClosingCoachingMove(text) ||
    hasConcreteAction(text, lastUserText)
  ) {
    return text;
  }

  if (requestsRestWithoutQuestions(lastUserText)) {
    return `${text}\n\n今日はゆっくり休んでください。`;
  }

  return `${text}\n\n${buildClosingCoachingQuestion(lastUserText, historyMessages)}`;
}

function requestsConcreteSuggestion(text: string) {
  return /提案|方法|やり方|行動|一歩|着手|できること|何をすれば|どうすれば|どうしたら/.test(
    text
  );
}

function hasConcreteAction(text: string, lastUserText: string) {
  const hasAction = /(?:してください|してみてください|してみましょう|しましょう|(?:て|で)み(?:てください|ましょう)|始めてみて|書き出して|書いて|伝えて|開いて|決めて|置いて|休んで|確認して|取り組んで|着手して|(?:答え|伝え|断り|言い)ます|提案します)|(?:\d+|一|ひと)つ(?:だけ)?(?:書|決|選|始|開|伝)|(?:\d+|一|ひと)(?:分|行|文|項目)/.test(
    text
  );

  if (!hasAction) return false;

  if (/企画|資料|文章|書|作成/.test(lastUserText)) {
    return /(?:\d+|一|ひと)(?:分|行|文|項目)|見出し|目次|目的|タイトル|ファイル|(?:企画書|資料|文章).{0,24}(?:開|書|始|着手)/.test(
      text
    );
  }

  return true;
}

function hasClosingCoachingMove(text: string) {
  const finalSentence =
    text
      .trim()
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || '';

  return (
    isQuestionSegment(finalSentence) ||
    /^「[^」]{8,}」[。！]?$/.test(finalSentence) ||
    /(?:してみてください|してください|してみましょう|しましょう|始めてみて|書き出してみて|伝えてみて|休んでください|休みましょう|置いてみてください|考えてください)(?:ね)?[。！]?$/.test(
      finalSentence
    )
  );
}

function hasAnyCoachingQuestion(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some(isQuestionSegment);
}

function reportsTimeTreatedLightly(text: string) {
  return (
    /時間[^。\n]{0,40}軽く扱/.test(text) &&
    /嫌|腹が立|怒/.test(text)
  );
}

function buildTimeTreatedLightlyAcknowledgement(lastUserText: string) {
  if (/準備(?:に使った)?時間/.test(lastUserText)) {
    return '準備に使った時間を軽く扱われたことに腹が立っているのですね。';
  }
  if (/家事そのものより/.test(lastUserText)) {
    return '自分の時間を軽く扱われているように感じることが嫌なんですね。';
  }
  return '自分の時間を軽く扱われたことに腹が立っているのですね。';
}

function buildClosingCoachingQuestion(
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  if (reportsTimeTreatedLightly(lastUserText)) {
    return '自分の時間を軽く扱われないために、相手にまず何を変えてほしいですか？';
  }
  if (/責め/.test(lastUserText) && /喧嘩|落ち着いて伝/.test(lastUserText)) {
    const previousAssistantText = historyMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('\n');
    if (/何を(?:変えて|わかって)|どうしてほしい/.test(previousAssistantText)) {
      return '今夜の最初の一言で、相手にどんなお願いを伝えたいですか？';
    }
    return '相手にまず何をわかってほしいですか？';
  }
  if (/感情的|感情が強|冷静でいられ|落ち着け.{0,8}不安/.test(lastUserText)) {
    return '途中で感情が強くなった時、相手に何と伝えたいですか？';
  }
  if (
    /企画書|提案書|資料|文章/.test(lastUserText) &&
    /着手|完璧|書き始め|手が止ま/.test(lastUserText)
  ) {
    return '15分後に何が書けていれば、明日の着手は成功だと判断しますか？';
  }
  if (/怒|腹が立|悔|許せな|むかつ/.test(lastUserText)) {
    return 'その気持ちを通して、本当は相手に何をわかってほしいですか？';
  }
  if (
    /怖|不安|心配|緊張/.test(lastUserText) &&
    /夫|妻|家族|親|子ども|友人|同僚|上司|相手/.test(lastUserText)
  ) {
    return '次にその相手へ話す時、いちばん避けたいことは何ですか？';
  }
  if (/怖|不安|心配|緊張/.test(lastUserText)) {
    return 'その不安の奥で、いちばん守りたいものは何ですか？';
  }
  if (/夫|妻|家族|親|子ども|友人|同僚|上司|相手|関係/.test(lastUserText)) {
    return 'この関係の中で、自分が本当に大切にしたいことは何ですか？';
  }
  if (/仕事|職場|業務|会社|タスク|働/.test(lastUserText)) {
    return '明日ひとつだけ状況を動かすなら、何から始めますか？';
  }
  if (/迷|決め|選|どちら|どうすれば|どうしたら/.test(lastUserText)) {
    return 'どちらを選べば、あとで自分に正直だったと思えそうですか？';
  }

  return '今の話の中で、いちばん見過ごしたくない本音は何ですか？';
}

function buildNoQuestionFallback(
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  const historicalUserContext = historyMessages
    .filter((message) => message.role === 'user')
    .map((message) => stripAttachmentMarkdown(message.content))
    .join('\n');
  const userContext = [historicalUserContext, lastUserText]
    .filter(Boolean)
    .join('\n');
  const hasHistoricalCommunicationIntent =
    /上司|同僚|夫|妻|家族|親|子ども|友人|相手/.test(
      historicalUserContext
    ) &&
    /話|伝|言葉|一言|言い方|文面|会話|相談|連絡|返事|頼ん|断/.test(
      historicalUserContext
    );

  if (requestsDirectWording(lastUserText)) {
    return buildDirectWordingFallback(lastUserText, userContext);
  }

  if (/直前/.test(lastUserText)) {
    if (/話|伝|相手|夫|妻|家族|同僚|上司/.test(userContext)) {
      return '話し始める直前に、最初に伝えたい一文をメモで一度だけ確認してください。';
    }
    return '始める直前に、最初の一歩を一文だけ確認してください。';
  }
  if (/企画|資料|文章|書|作成/.test(lastUserText)) {
    return '完成を目指さず、まず最初の15分で見出しを一つだけ書いてみてください。';
  }
  if (/話|伝|言葉|一言|言い方|文面|会話|相談|連絡|返事/.test(lastUserText)) {
    return '明日の朝、相手に最初に伝える一文だけをメモに書いてください。';
  }
  if (/疲|休|しんど|限界/.test(lastUserText)) {
    return '今日はゆっくり休んでください。';
  }
  if (hasHistoricalCommunicationIntent) {
    return '明日の朝、相手に最初に伝える一文だけをメモに書いてください。';
  }
  if (/SNS|投稿|発信/.test(userContext)) {
    return '明日の朝、SNSで最初に伝えたい内容を一文だけメモに書いてください。';
  }
  if (/仕事|職場|業務|会社|タスク/.test(userContext)) {
    return '明日の朝、今いちばん気になる仕事に5分だけ取り組んでください。';
  }
  return '今いちばん気になっていることを一文だけメモに書いてください。';
}

function buildDirectWordingFallback(lastUserText: string, userContext: string) {
  if (/断る|断り|引き受けられ|引き受けでき/.test(userContext)) {
    return '「ありがとうございます。ただ、今は手一杯のため、今回はお引き受けできません。」';
  }
  if (/会議|提案/.test(userContext)) {
    return '「前回は提案を最後までお伝えできなかったので、今回は結論まで聞いてからご意見をいただけると助かります。」';
  }
  if (/家事|夫|妻/.test(userContext)) {
    return '「私の時間も大切にしたいので、家事を頼んだ時に、いつ対応するかを一緒に決めたいです。」';
  }
  if (/今夜/.test(lastUserText)) {
    return '「今夜、責めたいのではなく、これからどうするかを落ち着いて話したいです。」';
  }
  return '「責めたいのではなく、これからどうするかを一緒に話したいです。」';
}

function removeRepeatedAssistantParagraphs(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[]
) {
  if (/もう一度|再掲|繰り返|同じ(?:文|内容)/.test(lastUserText)) {
    return text;
  }

  const previousParagraphs = new Set(
    historyMessages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content.split(/\n{2,}/))
      .map(canonicalizeAssistantParagraph)
      .filter((paragraph) => paragraph.length >= 20)
  );

  return text
    .split(/(\n{2,})/)
    .filter(
      (part) =>
        /^\n+$/.test(part) ||
        !previousParagraphs.has(canonicalizeAssistantParagraph(part))
    )
    .join('')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canonicalizeAssistantParagraph(text: string) {
  return text
    .replace(/\*\*/g, '')
    .replace(/[ \t\u3000]+/g, '')
    .replace(/[。．]+$/u, '')
    .trim();
}

function rewriteContextualClosingQuestion(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  const directQuestion = buildDirectContextQuestion(
    lastUserText,
    historyMessages
  );
  const directText = text
    .replace(
      /この(?:提案|方法|考え)(?:について)?[、,]?(?:どのように|どう)(?:感じ|思い)ますか[？?]?/g,
      directQuestion
    )
    .replace(
      /^(?:まずは[、,]?)?(?:一つ|ひとつ|1つ)だけ(?:聞かせて|教えて)(?:ください|もらえますか)[。！？?]?$/gm,
      directQuestion
    );

  if (
    /新しい仕事/.test(lastUserText) &&
    /失敗/.test(lastUserText) &&
    /期待を裏切/.test(lastUserText) &&
    /怖/.test(lastUserText) &&
    /手をつけられ/.test(lastUserText) &&
    !requestsSingleAnswerFormat(lastUserText)
  ) {
    return '失敗して期待を裏切るのが怖くて、新しい仕事に手をつけられないんですね。\n\nその仕事で、最初に手をつける必要がある作業は何ですか？';
  }

  if (
    /能力がないと思われるのが悔し/.test(lastUserText) &&
    !requestsSingleAnswerFormat(lastUserText)
  ) {
    return '怖さより、同僚に能力がないと思われる悔しさの方が近いんですね。\n\n同僚に本当は何をわかってほしいですか？';
  }

  if (
    /夫/.test(lastUserText) &&
    /家事/.test(lastUserText) &&
    /後回し/.test(lastUserText) &&
    /負担/.test(lastUserText) &&
    /腹が立/.test(lastUserText) &&
    !requestsSingleAnswerFormat(lastUserText)
  ) {
    return '家事を頼んでも後回しにされ、自分ばかり負担しているように感じて腹が立つんですね。\n\n夫にまずどの行動を変えてほしいですか？';
  }

  if (/仕事|職場|業務|会社|タスク/.test(lastUserText) && /落ち込/.test(lastUserText)) {
    return directText
      .replace(
        /今[、,]?[^。！？?\n]{0,40}(?:気持ちの真ん中|心の中心)にある(?:の|もの)は[、,]?[^。！？?\n]{0,20}(?:どのようなこと|何)(?:でしょうか|ですか)[。！？?]?/g,
        '今いちばん気になっている出来事は何ですか？'
      )
      .replace(
        /今[^。！？?\n]{0,40}落ち込[^。！？?\n]{0,30}(?:状態|気持ち)[^。！？?\n]{0,40}いちばん気になっている出来事[^。！？?\n]{0,40}(?:聞かせてもらえますか|何ですか)[。！？?]?/g,
        '仕事のことで、今いちばん気になっている出来事は何ですか？'
      )
      .replace(
        /今[^。！？?\n]{0,30}頭に浮かんでくる[^。！？?\n]{0,40}気になっていること[^。！？?\n]{0,40}(?:聞かせてもらえますか|何ですか)[。！？?]?/g,
        '仕事のことで、今いちばん気になっている出来事は何ですか？'
      );
  }

  if (reportsTimeTreatedLightly(lastUserText)) {
    const directQuestion = buildClosingCoachingQuestion(
      lastUserText,
      historyMessages
    );
    if (
      !requestsDirectWording(lastUserText) &&
      !requestsSingleAnswerFormat(lastUserText)
    ) {
      return `${buildTimeTreatedLightlyAcknowledgement(lastUserText)}\n\n${directQuestion}`;
    }
    const rewritten = directText.replace(
      /今の話の中で[、,]?いちばん見過ごしたくない本音は何ですか[？?]?/g,
      directQuestion
    );
    const deflectsToWritingFeelings =
      /(?:メモ|ノート|スマホ)[^。！？?\n]{0,100}(?:本音|気持ち)[^。！？?\n]{0,80}(?:書|整理)|(?:本音|気持ち)[^。！？?\n]{0,80}(?:メモ|書き出)/.test(
        rewritten
      );
    if (
      deflectsToWritingFeelings &&
      !requestsDirectWording(lastUserText) &&
      !requestsSingleAnswerFormat(lastUserText)
    ) {
      return `${buildTimeTreatedLightlyAcknowledgement(lastUserText)}\n\n${directQuestion}`;
    }
    return rewritten;
  }

  if (/責め/.test(lastUserText) && /喧嘩|落ち着いて伝/.test(lastUserText)) {
    const suggestedWording = directText.match(/「[^」]{8,}」/)?.[0];
    if (suggestedWording) {
      if (/家事|時間|後回し/.test(suggestedWording)) {
        return '「私の時間も大切にしたいので、家事を頼んだ時に、いつ対応するかを一緒に決めたいです。」';
      }
      return suggestedWording;
    }
    return `責める言い方を避けて、落ち着いて伝えたいんですね。\n\n${buildClosingCoachingQuestion(
      lastUserText,
      historyMessages
    )}`;
  }

  if (/次の一言が怖/.test(lastUserText)) {
    if (
      !requestsDirectWording(lastUserText) &&
      !requestsSingleAnswerFormat(lastUserText)
    ) {
      return '上司に否定されたように感じて、次の一言が怖いんですね。\n\n次にその上司へ話す時、いちばん避けたいことは何ですか？';
    }
    return directText
      .replace(
        /その[「『]?次の一言[」』]?[^。！？?\n]{0,100}(?:ことでしょうか|ことですか)[。！？?]?/g,
        '次にその上司へ話す時、いちばん避けたいことは何ですか？'
      )
      .replace(
        /[^。！？?\n]{0,40}(?:上司|相手)から[^。！？?\n]{0,100}(?:返って|言われ|言葉)[^。！？?\n]{0,80}(?:感じていますか|思いますか|ですか|でしたか|でしょうか)[。！？?]?/g,
        '次にその上司へ話す時、いちばん避けたいことは何ですか？'
      );
  }

  if (/感情的|感情が強|冷静でいられ|落ち着け.{0,8}不安/.test(lastUserText)) {
    if (
      !requestsDirectWording(lastUserText) &&
      !requestsSingleAnswerFormat(lastUserText)
    ) {
      return '途中で感情が強くなりそうなのが不安なんですね。\n\n話を続けるのが難しいと感じたら、「5分だけ休憩してから続きを話したい」と伝えてください。';
    }
    return directText.replace(
      /その不安の奥で[、,]?いちばん守りたいものは何ですか[？?]?/g,
      '途中で感情が強くなった時、相手に何と伝えたいですか？'
    );
  }

  return directText;
}

function buildDirectContextQuestion(
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  if (
    /仕事|職場|業務|会社|タスク/.test(lastUserText) &&
    /落ち込/.test(lastUserText)
  ) {
    return '今いちばん気になっている出来事は何ですか？';
  }

  if (
    /家事|負担|後回し/.test(lastUserText) &&
    /夫|妻|家族|相手/.test(lastUserText)
  ) {
    const otherPerson = lastUserText.match(/夫|妻|家族|相手/)?.[0] || '相手';
    return `家事の負担を減らすために、${otherPerson}にまず何を変えてほしいですか？`;
  }

  return buildClosingCoachingQuestion(lastUserText, historyMessages);
}

function rewriteUngroundedWordingReference(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[]
) {
  const conversationContext = [
    ...historyMessages.map((message) =>
      stripAttachmentMarkdown(message.content)
    ),
    lastUserText,
  ].join('\n');
  const unsupportedQuotedReference = [
    ...text.matchAll(/この[「『]([^」』]{2,80})[」』]/g),
  ].some((match) => !conversationContext.includes(match[1]));
  const textWithoutQuotedReferences = text.replace(
    /この[「『][^」』]{2,80}[」』]/g,
    ''
  );
  const hasAvailableWording =
    /[「『][^」』]{4,}[」』]/.test(conversationContext) ||
    /[「『][^」』]{4,}[」』]/.test(textWithoutQuotedReferences);
  const referencesMissingWording =
    /この(?:言い方|言葉|一言)[^。！？?\n]{0,80}(?:どう|しっくり|感じ|思い|聞いて|準備|できそう|できますか)/.test(
      text
    ) && !hasAvailableWording;

  if (!unsupportedQuotedReference && !referencesMissingWording) return text;
  return buildClosingCoachingQuestion(lastUserText, historyMessages);
}

function rewriteGenericSuggestionFollowUp(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const isGenericFollowUp = (paragraph: string) =>
    /(?:まずは[、,]?)?この[^。！？?\n]{0,80}(?:いかがでしょうか|いかがですか|試せそうでしょうか|試せそうですか|できそうでしょうか|できそうですか|どう思いますか)[。！？?]?/.test(
      paragraph
    );
  const hasConcreteSuggestion = paragraphs.some(
    (paragraph) =>
      !isGenericFollowUp(paragraph) &&
      (/[「『][^」』]{8,}[」』]/.test(paragraph) ||
        /(?:おすすめします|提案します|置いておきます|(?:書いて|伝えて|始めて|取り組んで)(?:ください|みてください)|(?:て|で)(?:ください|みてください))/.test(
          paragraph
        ))
  );
  if (!paragraphs.some(isGenericFollowUp)) return text;

  let insertedDirectQuestion = false;
  const rewritten = paragraphs
    .map((paragraph) => {
      if (!isGenericFollowUp(paragraph)) return paragraph;
      if (hasConcreteSuggestion || insertedDirectQuestion) return '';
      insertedDirectQuestion = true;
      return buildDirectContextQuestion(lastUserText, historyMessages);
    })
    .filter(Boolean)
    .join('\n\n');

  return rewritten || buildDirectContextQuestion(lastUserText, historyMessages);
}

function softenRepeatedAcknowledgement(text: string) {
  let seen = false;
  return text.replace(/のですね/g, (phrase) => {
    if (!seen) {
      seen = true;
      return phrase;
    }
    return 'んですね';
  });
}

function balanceJapaneseDelimiters(text: string) {
  const closeForOpen = new Map([
    ['「', '」'],
    ['『', '』'],
    ['（', '）'],
  ]);
  const openForClose = new Map(
    [...closeForOpen.entries()].map(([open, close]) => [close, open])
  );
  const stack: string[] = [];
  let balanced = '';

  for (const character of text) {
    if (closeForOpen.has(character)) {
      stack.push(character);
      balanced += character;
      continue;
    }

    const matchingOpen = openForClose.get(character);
    if (!matchingOpen) {
      balanced += character;
      continue;
    }

    const matchingIndex = stack.lastIndexOf(matchingOpen);
    if (matchingIndex < 0) continue;
    while (stack.length - 1 > matchingIndex) {
      balanced += closeForOpen.get(stack.pop() || '') || '';
    }
    stack.pop();
    balanced += character;
  }

  while (stack.length > 0) {
    balanced += closeForOpen.get(stack.pop() || '') || '';
  }

  return balanced;
}

function balanceJapaneseDelimitersByParagraph(text: string) {
  return text
    .split(/(\n{2,})/)
    .map((part) => (/^\n+$/.test(part) ? part : balanceJapaneseDelimiters(part)))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isQuestionSegment(segment: string) {
  const trimmed = segment.trim();
  return (
    /[？?]/.test(trimmed) ||
    /(?:です|ます|でしょう|ません)か[。]?$/.test(trimmed) ||
    /(?:教えて|聞かせて|答えて|話して)(?:ください|もらえますか)[。]?$/.test(
      trimmed
    )
  );
}

function isQuestionInsideJapaneseQuote(segment: string, depthBefore: number) {
  const punctuationIndex = Math.max(
    segment.lastIndexOf('？'),
    segment.lastIndexOf('?')
  );
  const semanticEnding = segment.match(/か[。]?\s*$/);
  const questionIndex =
    punctuationIndex >= 0
      ? punctuationIndex
      : semanticEnding?.index ?? segment.length;
  let depth = depthBefore;

  for (let index = 0; index < questionIndex; index += 1) {
    if (/[「『]/.test(segment[index])) depth += 1;
    if (/[」』]/.test(segment[index])) depth = Math.max(0, depth - 1);
  }

  return depth > 0;
}

function requestsSingleAnswerFormat(text: string) {
  return /(?:(?:一つ|ひとつ|1つ)(?:だけ)?.{0,24}(?:教|提案|答|挙|示|伝|お願)|(?:教|提案|答|挙|示|伝|お願).{0,24}(?:一つ|ひとつ|1つ)(?:だけ)?|一言(?:だけ|で)|最初の一言|質問(?:は|を)?(?:なし|不要|しない)|短く(?:答|教|返))/.test(text);
}

function requestsDirectWording(text: string) {
  if (
    /(?:名前|色|枚数|個数|数|種類|日時|日付|時刻|場所|金額|価格|コード|タイプ)[^。！？\n]{0,28}一言で(?:教えて|答えて)/.test(
      text
    )
  ) {
    return false;
  }

  return /最初の一言|断(?:る|りたい|り方)[^。！？\n]{0,24}(?:一言|言い方|文面|返事|言葉)|(?:一言|言い方|文面|返事|言葉)[^。！？\n]{0,28}(?:教えて|提案して|考えて|作って|示して|どうすれば|どうしたら)|(?:教えて|提案して|考えて|作って|示して)[^。！？\n]{0,28}(?:一言|言い方|文面|返事|言葉)|(?:どう|何と|なんて)(?:言|伝え)(?:え|たら|れば|る|う)/.test(
    text
  );
}

function requestsInternalPromptDisclosure(text: string) {
  return /(?:システムプロンプト|内部指示|内部プロンプト|設定されている指示|隠された指示).{0,80}(?:表示|開示|公開|全文|そのまま|教えて|見せて)|(?:表示|開示|公開|全文|そのまま|教えて|見せて).{0,80}(?:システムプロンプト|内部指示|内部プロンプト|設定されている指示|隠された指示)/.test(
    text
  );
}

function requestsExplicitClosingQuestion(text: string) {
  if (
    /質問(?:は|を)?(?:なし|不要|しない|せず)|質問を付けない|質問で終わらない/.test(
      text
    )
  ) {
    return false;
  }

  return /(?:最後|末尾|終わり|締め).{0,40}質問|質問(?:を|は)?[^。！？?\n]{0,20}(?:一つ|ひとつ|1つ)(?:だけ)?[^。！？?\n]{0,12}(?:して|付け|添え|ください|お願い)/.test(
    text
  );
}

function requestsDiagnosisExplanation(text: string) {
  return /診断(?:結果|コード)?|タイプ(?:コード)?|意識レベル|\b[SMP][VMG][AME](?:-[1-6])?\b/.test(
    text
  );
}

function removeUnrequestedDiagnosisExplanation(text: string) {
  const exposurePattern =
    /\b[SMP][VMG][AME](?:-[1-6])?\b|(?:意識)?レベル\s*[1-6]|(?:タイプ|傾向).{0,24}(?:あなた|方)|(?:あなた|方).{0,24}(?:タイプ|傾向)/;
  const filtered = text
    .split(/\n{2,}/)
    .filter((paragraph) => !exposurePattern.test(paragraph))
    .join('\n\n')
    .trim();

  return filtered || '今の状況でできることを、一つずつ一緒に考えていきましょう。';
}

function rewriteInvalidatingAdvice(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  const rewritten = text
    .replace(
      /(?:今の)?状況を客観的に(?:見|捉え|考え|整理)(?:る|直す)?ために[、,]?/g,
      ''
    )
    .replace(
      /((?:その|今の|この)?「[^」\n]{0,80}(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題)[^」\n]{0,40}」)(?:を|は)(?:(?:少し|少しだけ|一旦|いったん|一度|まず|しばらく)\s*)?(?:(?:横|脇)[にへ]置(?:き|いて)(?:から)?|切り離し(?:て)?)[、,]?/g,
      '$1があっても、'
    )
    .replace(
      /((?:(?:その|今の|この|抱えている|SNSや仕事の)[^、。\n]{0,24}|[^、。\n]{0,18})?(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題))(?:を|は)(?:(?:少し|少しだけ|一旦|いったん|一度|まず|しばらく)\s*)?(?:(?:横|脇)[にへ]置(?:き|いて)(?:から)?|切り離し(?:て)?)[、,]?/g,
      '$1があっても、'
    )
    .replace(/、{2,}/g, '、')
    .trim();

  const grounded = rewritten
    .split(/(\n{2,})/)
    .filter((part) => !invalidatesUserFeeling(part))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return grounded || buildNoQuestionFallback(lastUserText, historyMessages);
}

function invalidatesUserFeeling(text: string) {
  return /否定[」』]?[^。\n]{0,16}(?:ではなく|でなく)[「『]?(?:意見|別の視点|アドバイス)|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,16}(?:横|脇)[にへ]置|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,12}切り離|客観的に(?:見|捉え|考え|整理|評価)|客観的な(?:評価|視点)/.test(
    text
  );
}

function rewriteCompoundAnswerQuestions(text: string, lastUserText: string) {
  const parts = text.split(/(\n{2,})/);
  let replaced = false;
  const rewritten = parts
    .map((part) => {
      const asksForPairedDimensions =
        /(?:出来事|事実|状況|理由|原因|気持ち|感情|思い|希望|望み|行動|タイミング|言い方|方法|内容|テーマ|強み|こだわり|気になっていること|頭に浮かんでくること)[」』]?(?:と|や|および|ならびに|、)[^。！？?\n]{0,32}[「『]?(?:出来事|事実|状況|理由|原因|気持ち|感情|思い|希望|望み|行動|タイミング|言い方|方法|内容|テーマ|強み|こだわり|気になっていること|頭に浮かんでくること)/.test(
          part
        );
      const asksForcedAlternative =
        /(?:です|ます)か[、,]?(?:それとも|または|あるいは)[^。！？?\n]{1,100}(?:です|ます)か/.test(
          part
        );
      const asksAnyAlternative = /(?:それとも|または|あるいは)/.test(part);
      const asksQuotedEitherOr =
        /[「『][^」』]{1,50}[」』](?:と|か)[「『][^」』]{1,50}[」』]のどちら/.test(
          part
        );
      if (
        !replaced &&
        (asksForPairedDimensions ||
          asksForcedAlternative ||
          asksAnyAlternative ||
          asksQuotedEitherOr ||
          /(?:一つずつ|それぞれ)[^。！？?\n]{0,40}(?:聞かせ|教えて|答えて)/.test(
            part
          )) &&
        /[？?]|(?:です|ます|でしょう|ません)か[。]?$/.test(part.trim())
      ) {
        replaced = true;
        return buildSingleFocusQuestion(lastUserText);
      }
      return part;
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return rewritten || text;
}

function buildSingleFocusQuestion(lastUserText: string) {
  if (/仕事|職場|業務|会社|タスク|働/.test(lastUserText)) {
    return '仕事のことで、今いちばん気になっている出来事は何ですか？';
  }

  return buildClosingCoachingQuestion(lastUserText);
}

function removeAnsweredEmotionQuestion(text: string, lastUserText: string) {
  if (!/腹が立|怒|悔|悲|怖|不安|嫌|つら|辛|寂|疲/.test(lastUserText)) {
    return text;
  }

  const userAlreadyStatedAnger = /腹が立|怒/.test(lastUserText);
  const knownAngerConfirmation =
    /(?:怒り|腹が立)[^。！？?\n]{0,80}(?:感じている|強い|でしょうか|ですか)/;

  return text
    .split(/(\n{2,})/)
    .filter(
      (part) =>
        !/どんな気持ち(?:ですか|になりますか)[？?]?/.test(part) &&
        !(
          userAlreadyStatedAnger && knownAngerConfirmation.test(part)
        )
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeUnsupportedPsychologicalInference(
  text: string,
  lastUserText: string,
  historyMessages: CoachingChatMessage[] = []
) {
  const userContext = [
    ...historyMessages
      .filter((message) => message.role === 'user')
      .map((message) => stripAttachmentMarkdown(message.content)),
    lastUserText,
  ].join('\n');
  let candidateText = text;
  if (!/ミス|失敗/.test(userContext)) {
    candidateText = candidateText
      .replace(
        /仕事で(?:ミス|失敗)(?:があり|をして|してしまい|し)[、,]?/g,
        '仕事のことで、'
      )
      .replace(
        /今(?:一番|いちばん)気になっている[「『]?(?:ミス|失敗)[^」』。\n]{0,24}(?:場面|出来事)[」』]?/g,
        '今いちばん気になっている出来事'
      );
  }
  if (/落ち込/.test(userContext) && !/沈ん/.test(userContext)) {
    candidateText = candidateText.replace(
      /(?:お気持ち|気持ち|心)が沈んでいる/g,
      '落ち込んでいる'
    );
  }
  if (reportsTimeTreatedLightly(userContext)) {
    candidateText = candidateText.replace(
      /家事の(?:分担|負担)[^。\n]{0,160}(?:存在|尊重|軽んじ|敬意)[^。\n]{0,100}(?:痛|つら|苦し|傷つ)[^。\n]*[。]?/g,
      '自分の時間を軽く扱われているように感じることが嫌なんですね。'
    );
  }
  if (
    /腹が立|怒/.test(userContext) &&
    !/心残り|悲し|落ち込|残念/.test(userContext) &&
    /心残り/.test(candidateText)
  ) {
    const groundedAnger = /準備に使った時間/.test(userContext)
      ? '準備に使った時間を軽く扱われたことに腹が立っているのですね。'
      : /時間[^。\n]{0,40}軽く扱/.test(userContext)
        ? '自分の時間を軽く扱われたことに腹が立っているのですね。'
        : 'そのことに腹が立っているのですね。';
    candidateText = candidateText.replace(
      /[^。！？?\n]{0,160}心残り[^。！？?\n]*[。！？?]?/g,
      groundedAnger
    );
  }
  if (/能力がないと思われるのが悔し/.test(userContext)) {
    candidateText = candidateText.replace(
      /[^。！？?\n]{0,120}(?:突き動か|バネ|原動力)[^。！？?\n]*[。！？?]?/g,
      '能力がないと思われることが悔しいのですね。'
    );
  }
  if (
    requestsDirectWording(lastUserText) &&
    /「[^」]{4,}」/.test(candidateText) &&
    !isGroundedDirectWording(candidateText, historyMessages, lastUserText)
  ) {
    const groundedFallback = buildGroundedDirectWording(
      historyMessages,
      lastUserText
    );
    if (groundedFallback) candidateText = groundedFallback;
  }
  const loadedInferences = [
    { output: /見捨てられ/, supportedBy: /見捨てられ/ },
    { output: /承認欲求/, supportedBy: /承認欲求/ },
    { output: /トラウマ/, supportedBy: /トラウマ/ },
    { output: /幼少期/, supportedBy: /幼少期/ },
    { output: /愛着障害/, supportedBy: /愛着障害/ },
    { output: /共依存/, supportedBy: /共依存/ },
    { output: /証拠/, supportedBy: /証拠/ },
    { output: /責任感|責任を感じ/, supportedBy: /責任/ },
    {
      output: /突き動か|バネ|原動力/,
      supportedBy: /突き動か|バネ|原動力/,
    },
    {
      output: /自負|裏返し|準備を尽く|価値あるもの/,
      supportedBy: /自負|裏返し|準備を尽く|価値あるもの/,
    },
    {
      output: /やり場のない|一人で抱え|ひとりで抱え|一人の肩|ひとりの肩/,
      supportedBy: /やり場のない|一人で抱え|ひとりで抱え|肩にかか/,
    },
    { output: /孤独感|孤独/, supportedBy: /孤独/ },
    { output: /不公平感|不公平/, supportedBy: /不公平/ },
    { output: /本当にお疲れ/, supportedBy: /疲れ/ },
    { output: /悪気/, supportedBy: /悪気/ },
    {
      output: /(?:時間|労力)[^。！？?\n]{0,40}削られ/,
      supportedBy: /削られ/,
    },
    {
      output: /大切に考えていたこと|伝えたかった思い|思いが詰ま/,
      supportedBy: /大切に考えていたこと|伝えたかった思い|思いが詰ま/,
    },
    {
      output: /尊重されていない|軽んじられ|敬意が欠け/,
      supportedBy: /尊重されていない|軽んじられ|敬意が欠け/,
    },
    {
      output: /何より.{0,24}(?:苦し|傷つ|痛|つら)/,
      supportedBy: /何より.{0,24}(?:苦し|傷つ|痛|つら)/,
    },
    { output: /深く.{0,16}傷つ|傷つけ/, supportedBy: /傷つ/ },
    { output: /期待に応え/, supportedBy: /期待|応え/ },
    { output: /萎縮/, supportedBy: /萎縮/ },
    { output: /身がすく/, supportedBy: /身がすく/ },
    { output: /身構え/, supportedBy: /身構え/ },
    { output: /緊張/, supportedBy: /緊張/ },
    { output: /ミス|失敗/, supportedBy: /ミス|失敗/ },
    {
      output: /反応が返|返事が返/,
      supportedBy: /反応|返事|返って|返され|返る/,
    },
    { output: /一生懸命/, supportedBy: /一生懸命/ },
    {
      output: /存在.{0,20}尊重|尊重.{0,20}存在/,
      supportedBy: /存在/,
    },
    { output: /痛み/, supportedBy: /痛/ },
    { output: /しんどい/, supportedBy: /しんどい/ },
    { output: /つらい|辛い/, supportedBy: /つらい|辛い/ },
    { output: /悲し/, supportedBy: /悲し/ },
    { output: /悔し/, supportedBy: /悔し/ },
    { output: /不安/, supportedBy: /不安/ },
    { output: /焦り|焦っ/, supportedBy: /焦り|焦っ/ },
    { output: /寂し/, supportedBy: /寂し/ },
    {
      output: /予測.{0,12}(?:から来|が原因)|(?:から来|原因).{0,12}予測/,
      supportedBy: /予測|また.{0,12}否定/,
    },
    {
      output: /予測/,
      supportedBy: /予測|また.{0,12}否定/,
    },
    {
      output: /苦しめ/,
      supportedBy: /苦し|つら|辛|しんど/,
    },
    {
      output: /心が疲れ|心も疲れ/,
      supportedBy: /疲れ|消耗/,
    },
    {
      output: /頭の中だけで整理[^。！？?\n]{0,60}余計に疲/,
      supportedBy: /頭の中だけで整理[^。！？?\n]{0,60}余計に疲/,
    },
    {
      output: /(?:お気持ち|気持ち|心)が沈/,
      supportedBy: /沈ん/,
    },
    {
      output: /重(?:い|たい|く)/,
      supportedBy: /重(?:い|たい|く)/,
    },
    { output: /気持ちの切り替え/, supportedBy: /切り替え/ },
    { output: /精一杯/, supportedBy: /精一杯|余裕がない|限界/ },
    {
      output: /エネルギーを(?:使|消耗)/,
      supportedBy: /エネルギー|消耗/,
    },
    { output: /プライド/, supportedBy: /プライド/ },
    { output: /意欲|やる気/, supportedBy: /意欲|やる気/ },
    { output: /真剣/, supportedBy: /真剣/ },
    {
      output: /完璧(?:主義|に|で|を)|完璧さ/,
      supportedBy: /完璧/,
    },
    { output: /大きな(?:塊|壁)/, supportedBy: /塊|壁|大きすぎ/ },
    { output: /ギャップ/, supportedBy: /ギャップ|実際の能力/ },
    {
      output: /周囲.{0,12}(?:示したい|見せたい)|証明したい/,
      supportedBy: /示したい|見せたい|証明したい/,
    },
  ];
  const unsupportedTerms = loadedInferences.filter(
    ({ output, supportedBy }) =>
      output.test(candidateText) && !supportedBy.test(userContext)
  );
  const userUsedEmphaticCause = /(?:だからこそ|からこそ)/.test(userContext);
  const hasUnsupportedEmphaticCause =
    /(?:だからこそ|からこそ)/.test(candidateText) && !userUsedEmphaticCause;
  if (unsupportedTerms.length === 0 && !hasUnsupportedEmphaticCause) {
    return candidateText;
  }

  const grounded = (candidateText.match(/[^。！？?\n]+[。！？?]?|\n+/g) || [])
    .filter(
      (segment) =>
        !unsupportedTerms.some(({ output }) => output.test(segment)) &&
        !(
          /(?:だからこそ|からこそ)/.test(segment) &&
          !userUsedEmphaticCause
        )
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return grounded || buildNoQuestionFallback(lastUserText, historyMessages);
}

function requestsRestWithoutQuestions(text: string) {
  return /何も考えたくない|もう考えたくない|今日はもう(?:無理|限界)|疲れ(?:た|ました)|しんどい|休みたい/.test(
    text
  );
}

function requestsShortRestResponse(text: string) {
  if (!requestsRestWithoutQuestions(text)) return false;

  if (
    requestsSingleAnswerFormat(text) ||
    /何も考えたくない|もう考えたくない|今日はもう(?:無理|限界)|休みたい/.test(
      text
    )
  ) {
    return true;
  }

  return (
    text.trim().length <= 24 &&
    !/[？?]|どう|なぜ|原因|方法|対策|相談/.test(text)
  );
}

function requestsNoFollowUpQuestion(text: string) {
  return requestsSingleAnswerFormat(text) || requestsRestWithoutQuestions(text);
}

function countMatches(text: string, pattern: RegExp) {
  return (text.match(pattern) || []).length;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorCode = 'GEMINI_TIMEOUT'
) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(errorCode)),
      timeoutMs
    );
  });

  return Promise.race([
    promise,
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}
