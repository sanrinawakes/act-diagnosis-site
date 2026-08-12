import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { getJapanDateKey } from '@/lib/japan-date';
import {
  coachingConversationPriorityPrompt,
  getCoachingSystemPrompt,
  getContextualizedPrompt,
} from '@/data/coaching-system-prompt';
import {
  stripAttachmentMarkdown,
  type ChatImageAttachment,
} from '@/lib/attachments';
import { createServerClient } from '@/lib/supabase-server';
import {
  resolveChatAttachments,
  validateChatAttachments,
} from '@/lib/server-chat-attachments';
import {
  buildGeminiParts,
  compactCoachingMessages,
  createJsonLineStream,
  generateCoachingText,
  getStreamHeaders,
} from '@/lib/coaching-gemini';
import {
  FREE_DAILY_COACHING_LIMIT,
  releaseFreeDailyQuota,
  reserveFreeDailyQuota,
  type FreeDailyQuotaReservation,
} from '@/lib/free-coaching-quota';
import { validateFreeMessages } from '@/lib/free-chat-validation';
import {
  classifyCoachingScope,
  COACHING_SCOPE_GUIDANCE,
  createScopeBlockedStream,
} from '@/lib/coaching-scope';
import { hasAllowedRequestOrigin } from '@/lib/request-origin';
import { isFormerAwakesMemberWithoutAccess } from '@/lib/coaching-access';

export const runtime = 'nodejs';
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DIAGNOSIS_CODE_PATTERN = /^[A-Z]{3}-[1-6]$/;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  messages: ChatMessage[];
  diagnosisCode?: string;
  email: string;
  attachments?: ChatImageAttachment[];
  stream?: boolean;
}

function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Free version coaching prompt with a light study-session guidance layer.
 */
function getFreeCoachingSystemPrompt(diagnosisCode?: string): string {
  const personalizedPrompt = diagnosisCode
    ? getContextualizedPrompt(diagnosisCode)
    : getCoachingSystemPrompt();
  const baseFreePrompt = `${personalizedPrompt}

---

## 無料版に関する重要なガイダンス

このユーザーは無料版の簡易診断（15問）を受けています。簡易版では意識レベル2段階しか判定できず、27種類の性格タイプ判定もできません。まず相談内容に真摯に答え、そのうえで必要な時だけ、フルテストや無料オンライン勉強会に短く触れてください。

### コーチング方針
- ユーザーの質問や悩みへの回答を最優先にする。
- 簡易版の限界を説明する時は、短く自然に伝える。
- フルテストや勉強会の案内は、本文の最後に1〜2文だけ添える。
- ユーザーが深刻に悩んでいる時は、案内より共感と整理を優先する。
- 同じ誘導文を毎回繰り返さない。

### フルテストについて触れる時の言い方
- 「簡易版なので大まかな傾向として見ています。フルテストでは、より具体的な行動パターンまで見やすくなります」
- 「ここはもう少し深掘りできます。フルテストの結果があると、今の悩みに対してさらに具体的に見立てられます」
- 「気になれば、無料オンライン勉強会でフルテストについて確認できます」

### 無料オンライン勉強会への誘導
- 誘導は自然な流れがある時だけ、最後に短く添える。
- 長い宣伝文、強い煽り、毎回同じ文章は禁止。
- ユーザーが「詳しく知りたい」「もっと診断したい」と言った時は、勉強会案内を少し丁寧にする。

### トーン
- 売り込みではなく、必要な情報をそっと添える。
- ユーザーが話し続けたくなる自然な温度感を守る。
- 返答の中心は、あくまでコーチング体験にする。

### リンクの扱い
- 会話内で運営が明示したURL以外は、URLやリンク先を作らない。
- 勉強会を案内する時は「案内ページをご確認ください」と伝え、架空のリンクを表示しない。

---

${coachingConversationPriorityPrompt}`;

  return baseFreePrompt;
}

export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();
  const requestId = randomUUID();
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.replace('Bearer ', '')
    : '';

  try {
    // Browser requests use the login cookie. Bearer auth remains supported for
    // automated tests and non-browser clients.
    if (!token && !hasAllowedRequestOrigin(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = (await request.json()) as RequestBody;
    const messageValidation = validateFreeMessages(body.messages);
    if (!messageValidation.messages) {
      return NextResponse.json(
        { error: messageValidation.error || 'メッセージ内容が正しくありません。' },
        { status: 400 }
      );
    }
    const messages = messageValidation.messages;
    const diagnosisCode = body.diagnosisCode;
    const email = body.email;
    const attachments = body.attachments ?? [];
    const stream = body.stream === true;
    if (
      diagnosisCode !== undefined &&
      (typeof diagnosisCode !== 'string' || !DIAGNOSIS_CODE_PATTERN.test(diagnosisCode))
    ) {
      return NextResponse.json({ error: 'Invalid diagnosis code' }, { status: 400 });
    }
    const authClient = token
      ? createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        })
      : await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await (token
      ? authClient.auth.getUser(token)
      : authClient.auth.getUser());
    if (authError || !user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const requestedEmail =
      typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedEmail = user.email.trim().toLowerCase();
    if (requestedEmail && requestedEmail !== normalizedEmail) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const supabase = createAdminClient();
    const { data: accessProfile, error: accessProfileError } = await supabase
      .from('profiles')
      .select('role, subscription_status, is_active, awakes_access_started_at, awakes_access_expires_at')
      .eq('id', user.id)
      .maybeSingle();
    if (accessProfileError) {
      console.error('Free coaching AWAKES access lookup failed');
      return NextResponse.json({ error: '会員情報を確認できません。' }, { status: 503 });
    }
    if (isFormerAwakesMemberWithoutAccess(accessProfile)) {
      return NextResponse.json(
        { error: 'AWAKESの会員利用期間が終了しているため、AIコーチングは利用できません。' },
        { status: 403 }
      );
    }

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided' },
        { status: 400 }
      );
    }

    if (!Array.isArray(attachments)) {
      return NextResponse.json({ error: 'Invalid attachments format' }, { status: 400 });
    }
    const malformedAttachment = attachments.some((attachment) => {
      if (!attachment || typeof attachment !== 'object') return true;
      const candidate = attachment as unknown as Record<string, unknown>;
      const hasData = typeof candidate.data === 'string';
      const hasPath = typeof candidate.path === 'string';
      return (
        typeof candidate.name !== 'string' ||
        typeof candidate.mimeType !== 'string' ||
        hasData === hasPath
      );
    });
    if (malformedAttachment) {
      return NextResponse.json({ error: 'Invalid attachments format' }, { status: 400 });
    }

    // Reject non-coaching requests before attachment work, quota consumption, or an AI call.
    const scopeResult = classifyCoachingScope({
      messages,
      attachmentCount: attachments.length,
    });
    if (scopeResult.decision === 'blocked') {
      if (stream) {
        return new Response(
          createScopeBlockedStream({
            result: scopeResult,
            limit: FREE_DAILY_COACHING_LIMIT,
          }),
          { headers: getStreamHeaders() }
        );
      }

      return NextResponse.json({
        message: COACHING_SCOPE_GUIDANCE,
        limit: FREE_DAILY_COACHING_LIMIT,
        completionStatus: 'complete',
        finishReason: 'SCOPE_BLOCKED',
        scopeDecision: scopeResult.decision,
        scopeCategory: scopeResult.category,
        usage: {},
      });
    }

    const attachmentError = validateChatAttachments(
      attachments,
      user.id
    );
    if (attachmentError) {
      return NextResponse.json({ error: attachmentError }, { status: 400 });
    }

    const attachmentStartedAt = Date.now();
    let inlineAttachments;
    try {
      inlineAttachments = await withAttachmentTimeout(
        resolveChatAttachments(attachments, supabase),
        20000
      );
    } catch (error) {
      const timedOut =
        error instanceof Error && error.message === 'ATTACHMENT_LOAD_TIMEOUT';
      return NextResponse.json(
        {
          error: timedOut
            ? '画像の読み込みに時間がかかりすぎました。もう一度お試しください。'
            : '画像を読み込めませんでした。画像を選び直してください。',
        },
        { status: timedOut ? 504 : 502 }
      );
    }
    const attachmentMs = Date.now() - attachmentStartedAt;

    // Get or create free user and check rate limit
    const accountLookupStartedAt = Date.now();
    const { data: existingUser, error: selectError } = await supabase
      .from('free_users')
      .select('id')
      .eq('email', normalizedEmail)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const today = getJapanDateKey();

    if (selectError) {
      console.error('Error checking free user:', selectError);
      return NextResponse.json(
        { error: 'Database error' },
        { status: 500 }
      );
    }

    if (!existingUser) {
      // Create new free user
      const { error: insertError } = await supabase
        .from('free_users')
        .insert({
          email: normalizedEmail,
          chat_count_today: 0,
          last_chat_date: today,
          diagnosis_completed: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error('Error creating free user:', insertError);
        return NextResponse.json(
          { error: 'Failed to initialize free user' },
          { status: 500 }
        );
      }

    }
    const accountLookupMs = Date.now() - accountLookupStartedAt;

    let quotaReservation: FreeDailyQuotaReservation;
    try {
      quotaReservation = await reserveFreeDailyQuota({
        supabaseAdmin: supabase,
        userId: user.id,
        requestId,
        day: today,
      });
    } catch (quotaError) {
      console.error('Free coaching quota reservation failed:', quotaError);
      return NextResponse.json(
        { error: '利用回数を確認できませんでした。少し待ってから、もう一度お試しください。' },
        { status: 503 }
      );
    }

    if (!quotaReservation.allowed) {
      return NextResponse.json(
        {
          error: 'rate_limit',
          remaining: 0,
          message: `本日のAIコーチングの利用回数（${FREE_DAILY_COACHING_LIMIT}回）に達しました。明日以降にご利用いただくか、フル版をご利用ください。`,
        },
        { status: 429 }
      );
    }

    // Build system prompt with sales layer
    const systemPrompt = getFreeCoachingSystemPrompt(diagnosisCode);

    const compactMessages = compactCoachingMessages(messages);
    const lastUserMessage = compactMessages[compactMessages.length - 1];
    const lastUserText = stripAttachmentMarkdown(lastUserMessage.content);
    const historyMessages = compactMessages.slice(0, -1);
    const lastUserParts = buildGeminiParts(
      lastUserText,
      inlineAttachments,
      historyMessages
    );
    const telemetry = {
      route: '/api/free/chat',
      requestId,
      requestMessages: messages.length,
      compactMessages: compactMessages.length,
      historyMessages: historyMessages.length,
      attachments: inlineAttachments.length,
      lastUserChars: lastUserText.length,
      preStreamMs: Date.now() - requestStartedAt,
      attachmentMs,
      accountLookupMs,
    };

    const completeSuccessfulResponse = async () => {
      return {
        remaining: quotaReservation.remaining,
      };
    };

    if (stream) {
      return new Response(
        createJsonLineStream({
          systemPrompt,
          historyMessages,
          lastUserParts,
          onDone: completeSuccessfulResponse,
          telemetry,
        }),
        { headers: getStreamHeaders() }
      );
    }

    let assistantMessage: string;
    let usage;
    let completionStatus;
    let finishReason;
    try {
      const result = await generateCoachingText({
        systemPrompt,
        historyMessages,
        lastUserParts,
      });
      assistantMessage = result.text;
      usage = result.usage;
      completionStatus = result.completionStatus;
      finishReason = result.finishReason;
      console.info(
        JSON.stringify({
          event: 'chat_nonstream_done',
          ...telemetry,
          modelName: result.modelName,
          outputChars: assistantMessage.length,
          completionStatus,
          finishReason,
          provider: result.provider,
          qualityRepairAttempted: result.qualityRepairAttempted,
          qualityRepairAccepted: result.qualityRepairAccepted,
          qualityInitialIssues: result.qualityInitialIssues,
          qualityFinalIssues: result.qualityFinalIssues,
          usage,
        })
      );
    } catch (genErr) {
      await safelyReleaseFreeDailyQuota({
        supabase,
        userId: user.id,
        reservation: quotaReservation,
      });
      const isTimeout =
        genErr instanceof Error && genErr.message === 'GEMINI_TIMEOUT';
      console.error(
        JSON.stringify({
          event: 'chat_nonstream_error',
          ...telemetry,
          error: genErr instanceof Error ? genErr.message : String(genErr),
        })
      );
      return NextResponse.json(
        {
          error: isTimeout
            ? '応答に時間がかかりすぎたため中断しました。もう一度お試しください。'
            : 'AIの応答生成に失敗しました。もう一度お試しください。',
        },
        { status: isTimeout ? 504 : 502 }
      );
    }

    const { remaining } = await completeSuccessfulResponse();

    return NextResponse.json({
      message: assistantMessage,
      remaining,
      completionStatus,
      finishReason,
      usage,
    });
  } catch (error) {
    console.error('Free chat API error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'チャットの処理に失敗しました。時間をおいて、もう一度お試しください。' },
      { status: 500 }
    );
  }
}

async function safelyReleaseFreeDailyQuota(params: {
  supabase: ReturnType<typeof createAdminClient>;
  userId: string;
  reservation: FreeDailyQuotaReservation;
}) {
  if (!params.reservation.reservedNow) return;

  try {
    await releaseFreeDailyQuota({
      supabaseAdmin: params.supabase,
      userId: params.userId,
      requestId: params.reservation.requestId,
      day: params.reservation.day,
      limit: params.reservation.limit,
    });
  } catch (releaseError) {
    console.error('Free coaching quota release failed:', releaseError);
  }
}


function withAttachmentTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('ATTACHMENT_LOAD_TIMEOUT')),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}
