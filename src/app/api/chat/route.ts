import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createServerClient } from '@/lib/supabase-server';
import {
  getCoachingSystemPrompt,
  getContextualizedPrompt,
} from '@/data/coaching-system-prompt';
import {
  stripAttachmentMarkdown,
  type ChatImageAttachment,
} from '@/lib/attachments';
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
import { buildCoachingSessionContext } from '@/lib/coaching-session-memory';
import {
  COACHING_SCOPE_GUIDANCE,
  classifyCoachingScope,
  createScopeBlockedStream,
  type CoachingScopeResult,
} from '@/lib/coaching-scope';

export const runtime = 'nodejs';
// Vercel関数のデフォルト打ち切り(Hobby 10s)を延長し、Gemini生成の途中切断を防ぐ
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const DAILY_CHAT_LIMIT = 50; // 1日50往復まで
const AUTH_TIMEOUT_MS = 8000;
const PROFILE_TIMEOUT_MS = 8000;
const SETTINGS_TIMEOUT_MS = 5000;
const SESSION_CONTEXT_TIMEOUT_MS = 8000;
const ATTACHMENT_LOAD_TIMEOUT_MS = 20000;
const USAGE_AUDIT_TIMEOUT_MS = 3000;
const MAX_REQUEST_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 50000;
const MAX_TOTAL_MESSAGE_CHARS = 200000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIAGNOSIS_CODE_PATTERN = /^[SMP][VMG][AME]-[1-6]$/;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  messages: ChatMessage[];
  diagnosisCode?: string;
  attachments?: ChatImageAttachment[];
  stream?: boolean;
  sessionId?: string;
  session_id?: string;
}

export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();
  const requestId = randomUUID();

  try {
    console.info(
      JSON.stringify({
        event: 'chat_request_received',
        route: '/api/chat',
        requestId,
      })
    );

    // Browser requests use the login cookie. Bearer auth remains supported for
    // automated tests and non-browser clients.
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.replace('Bearer ', '')
      : '';
    const supabase = token
      ? createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        })
      : await createServerClient();

    let user;
    let userError;
    try {
      const authResult = await withStageTimeout(
        token ? supabase.auth.getUser(token) : supabase.auth.getUser(),
        AUTH_TIMEOUT_MS,
        'AUTH_TIMEOUT'
      );
      user = authResult.data.user;
      userError = authResult.error;
    } catch (error) {
      logPreflightError(requestId, 'auth', requestStartedAt, error);
      return NextResponse.json(
        {
          error:
            'ログイン状態の確認に時間がかかりました。入力内容は保存されています。画面を再読み込みして、もう一度送信してください。',
        },
        { status: 504 }
      );
    }

    if (userError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Service role client for rate limit updates (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Check daily chat limit
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    let profile;
    let profileError;
    try {
      const profileResult = await withStageTimeout(
        supabaseAdmin
          .from('profiles')
          .select('chat_count_today, last_chat_date, role, subscription_status, is_active, paid_test_credits')
          .eq('id', user.id)
          .single(),
        PROFILE_TIMEOUT_MS,
        'PROFILE_TIMEOUT'
      );
      profile = profileResult.data;
      profileError = profileResult.error;
    } catch (error) {
      logPreflightError(requestId, 'profile', requestStartedAt, error);
      return NextResponse.json(
        {
          error:
            '会員情報の確認に時間がかかりました。入力内容は保存されています。少し待ってから、もう一度送信してください。',
        },
        { status: 504 }
      );
    }

    if (profileError || !profile) {
      console.error('Profile fetch error:', profileError);
      return NextResponse.json(
        { error: '会員情報を確認できませんでした。少し待ってから、もう一度送信してください。' },
        { status: 503 }
      );
    }

    // 有料機能ガード（middleware.ts / useSubscriptionGuard.ts と同条件）。
    // 通常UIはmiddlewareで弾かれるが、APIを直接叩く経路の防御。
    if (profile && profile.role !== 'admin') {
      const hasActiveSubscription =
        profile.subscription_status === 'active' && profile.is_active;
      const hasPaidTestCredits = (profile.paid_test_credits || 0) > 0;
      if (!hasActiveSubscription && !hasPaidTestCredits) {
        return NextResponse.json(
          { error: '有料会員のみご利用いただけます。' },
          { status: 403 }
        );
      }
    }

    const currentChatCount =
      profile.last_chat_date === today ? profile.chat_count_today || 0 : 0;

    if (profile && profile.role !== 'admin') {
      const chatCountToday = currentChatCount;

      if (chatCountToday >= DAILY_CHAT_LIMIT) {
        return NextResponse.json(
          {
            error: `本日の利用上限（${DAILY_CHAT_LIMIT}往復）に達しました。明日またご利用ください。`,
            remaining: 0,
            limit: DAILY_CHAT_LIMIT,
          },
          { status: 429 }
        );
      }
    }

    // Check site settings
    let settings;
    let settingsError;
    try {
      const settingsResult = await withStageTimeout(
        supabase.from('site_settings').select('bot_enabled').single(),
        SETTINGS_TIMEOUT_MS,
        'SETTINGS_TIMEOUT'
      );
      settings = settingsResult.data;
      settingsError = settingsResult.error;
    } catch (error) {
      logPreflightError(requestId, 'settings', requestStartedAt, error);
    }

    if (settingsError) {
      console.error('Settings fetch error:', settingsError);
    }

    if (settings && !settings.bot_enabled) {
      return NextResponse.json(
        { error: 'Bot is currently disabled' },
        { status: 503 }
      );
    }

    const rawBody: unknown = await request.json();
    const bodyValidation = validateRequestBody(rawBody);
    if (!bodyValidation.body) {
      return NextResponse.json(
        { error: bodyValidation.error || 'Invalid request body' },
        { status: 400 }
      );
    }
    const body = bodyValidation.body;
    const {
      messages,
      diagnosisCode,
      attachments = [],
      stream = false,
      sessionId,
      session_id,
    } = body;

    const attachmentError = validateChatAttachments(attachments, user.id);
    if (attachmentError) {
      return NextResponse.json({ error: attachmentError }, { status: 400 });
    }

    const activeSessionId = sessionId || session_id || null;
    const scopeResult = classifyCoachingScope({
      messages,
      attachmentCount: attachments.length,
    });
    const usageAuditPromise = recordCoachingUsageEvent({
      supabaseAdmin,
      requestId,
      userId: user.id,
      sessionId: activeSessionId,
      result: scopeResult,
    });

    if (scopeResult.decision === 'blocked') {
      await usageAuditPromise;
      const remaining =
        profile.role === 'admin'
          ? DAILY_CHAT_LIMIT
          : Math.max(0, DAILY_CHAT_LIMIT - currentChatCount);
      console.warn(
        JSON.stringify({
          event: 'chat_scope_blocked',
          route: '/api/chat',
          requestId,
          userId: user.id,
          sessionId: activeSessionId,
          category: scopeResult.category,
          matchedRule: scopeResult.matchedRule,
          messageChars: scopeResult.messageChars,
          isLongMessage: scopeResult.isLongMessage,
          attachments: scopeResult.attachmentCount,
        })
      );

      if (stream) {
        return new Response(
          createScopeBlockedStream({
            result: scopeResult,
            remaining,
            limit: DAILY_CHAT_LIMIT,
          }),
          { headers: getStreamHeaders() }
        );
      }

      return NextResponse.json({
        message: COACHING_SCOPE_GUIDANCE,
        remaining,
        limit: DAILY_CHAT_LIMIT,
        completionStatus: 'complete',
        finishReason: 'SCOPE_BLOCKED',
        scopeDecision: scopeResult.decision,
        scopeCategory: scopeResult.category,
        usage: {},
      });
    }

    const attachmentStartedAt = Date.now();
    let inlineAttachments;
    try {
      inlineAttachments = await withStageTimeout(
        resolveChatAttachments(attachments, supabaseAdmin, {
          onRetry: ({ attachmentIndex, nextAttempt, error }) => {
            console.warn(
              JSON.stringify({
                event: 'chat_attachment_download_retry',
                route: '/api/chat',
                requestId,
                attachmentIndex,
                nextAttempt,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          },
        }),
        ATTACHMENT_LOAD_TIMEOUT_MS,
        'ATTACHMENT_LOAD_TIMEOUT'
      );
    } catch (error) {
      await usageAuditPromise;
      logPreflightError(requestId, 'attachments', requestStartedAt, error);
      const timedOut =
        error instanceof Error && error.message === 'ATTACHMENT_LOAD_TIMEOUT';
      return NextResponse.json(
        {
          error: timedOut
            ? '画像の読み込みに時間がかかりすぎました。入力内容は保存されています。もう一度お試しください。'
            : '画像を読み込めませんでした。画像を選び直して、もう一度お試しください。',
        },
        { status: timedOut ? 504 : 502 }
      );
    }

    // Build system prompt
    const systemPrompt = diagnosisCode
      ? getContextualizedPrompt(diagnosisCode)
      : getCoachingSystemPrompt();

    const contextStartedAt = Date.now();
    let sessionContext;
    try {
      sessionContext = await withStageTimeout(
        buildCoachingSessionContext({
          supabaseAdmin,
          sessionId: activeSessionId,
          userId: user.id,
          requestMessages: messages,
        }),
        SESSION_CONTEXT_TIMEOUT_MS,
        'SESSION_CONTEXT_TIMEOUT'
      );
    } catch (error) {
      logPreflightError(requestId, 'session_context', requestStartedAt, error);
      sessionContext = {
        messages: compactCoachingMessages(messages),
        totalStoredMessages: null,
        memoryUsed: false,
        memoryRefreshed: false,
        memoryCoveredMessages: null,
      };
    }
    const compactMessages = sessionContext.messages.length
      ? sessionContext.messages
      : compactCoachingMessages(messages);
    const lastUserMessage = compactMessages[compactMessages.length - 1];
    const lastUserText = stripAttachmentMarkdown(lastUserMessage.content);
    const lastUserParts = buildGeminiParts(lastUserText, inlineAttachments);
    const historyMessages = compactMessages.slice(0, -1);
    const telemetry = {
      route: '/api/chat',
      requestId,
      requestMessages: messages.length,
      compactMessages: compactMessages.length,
      historyMessages: historyMessages.length,
      attachments: inlineAttachments.length,
      lastUserChars: lastUserText.length,
      totalStoredMessages: sessionContext.totalStoredMessages,
      memoryUsed: sessionContext.memoryUsed,
      memoryRefreshed: sessionContext.memoryRefreshed,
      memoryCoveredMessages: sessionContext.memoryCoveredMessages,
      scopeCategory: scopeResult.category,
      isLongMessage: scopeResult.isLongMessage,
      preStreamMs: Date.now() - requestStartedAt,
      attachmentMs: Date.now() - attachmentStartedAt,
      contextMs: Date.now() - contextStartedAt,
    };

    const completeSuccessfulResponse = async () => {
      await usageAuditPromise;
      const newCount = currentChatCount + 1;

      const { error: countUpdateError } = await supabaseAdmin
        .from('profiles')
        .update({
          chat_count_today: newCount,
          last_chat_date: today,
        })
        .eq('id', user.id);

      if (countUpdateError) {
        throw new Error(`CHAT_COUNT_UPDATE_FAILED: ${countUpdateError.message}`);
      }

      return {
        remaining: profile?.role === 'admin' ? DAILY_CHAT_LIMIT : Math.max(0, DAILY_CHAT_LIMIT - newCount),
        limit: DAILY_CHAT_LIMIT,
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
          usage,
        })
      );
    } catch (genErr) {
      await usageAuditPromise;
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

    // Increment daily chat count
    const { remaining, limit } = await completeSuccessfulResponse();

    return NextResponse.json({
      message: assistantMessage,
      remaining,
      limit,
      completionStatus,
      finishReason,
      usage,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    console.error('Chat API error:', error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Internal server error',
      },
      { status: 500 }
    );
  }
}

function withStageTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  code: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(code)), timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
    clearTimeout(timeoutId)
  );
}

function logPreflightError(
  requestId: string,
  stage: string,
  startedAt: number,
  error: unknown
) {
  console.warn(
    JSON.stringify({
      event: 'chat_preflight_error',
      route: '/api/chat',
      requestId,
      stage,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

async function recordCoachingUsageEvent(params: {
  supabaseAdmin: SupabaseClient;
  requestId: string;
  userId: string;
  sessionId: string | null;
  result: CoachingScopeResult;
}) {
  try {
    const insertResult = await withStageTimeout(
      params.supabaseAdmin.from('coaching_usage_events').insert({
        request_id: params.requestId,
        user_id: params.userId,
        session_id: params.sessionId,
        decision: params.result.decision,
        category: params.result.category,
        matched_rule: params.result.matchedRule,
        message_chars: params.result.messageChars,
        total_request_chars: params.result.totalRequestChars,
        line_count: params.result.lineCount,
        is_long_message: params.result.isLongMessage,
        attachment_count: params.result.attachmentCount,
        provider_requested: params.result.decision === 'allowed',
      }),
      USAGE_AUDIT_TIMEOUT_MS,
      'USAGE_AUDIT_TIMEOUT'
    );

    if (insertResult.error) {
      throw new Error(`USAGE_AUDIT_FAILED: ${insertResult.error.message}`);
    }
  } catch (error) {
    // The paid chat must remain available if only the audit write fails. Keep a
    // structured event so operations can identify the failed request in logs.
    console.error(
      JSON.stringify({
        event: 'coaching_usage_audit_failed',
        route: '/api/chat',
        requestId: params.requestId,
        userId: params.userId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

function validateRequestBody(input: unknown): {
  body?: RequestBody;
  error?: string;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Invalid request body' };
  }

  const body = input as Record<string, unknown>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: 'No messages provided' };
  }
  if (body.messages.length > MAX_REQUEST_MESSAGES) {
    return { error: `Messages must be ${MAX_REQUEST_MESSAGES} items or fewer` };
  }

  let totalMessageChars = 0;
  const messages: ChatMessage[] = [];
  for (const item of body.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'Invalid message format' };
    }
    const message = item as Record<string, unknown>;
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string' ||
      !message.content.trim()
    ) {
      return { error: 'Invalid message format' };
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      return { error: `Each message must be ${MAX_MESSAGE_CHARS} characters or fewer` };
    }
    totalMessageChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }

  if (totalMessageChars > MAX_TOTAL_MESSAGE_CHARS) {
    return {
      error: `Total message content must be ${MAX_TOTAL_MESSAGE_CHARS} characters or fewer`,
    };
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { error: 'The last message must be from the user' };
  }

  const rawAttachments = body.attachments ?? [];
  if (!Array.isArray(rawAttachments)) {
    return { error: 'Invalid attachments format' };
  }
  const attachments: ChatImageAttachment[] = [];
  for (const item of rawAttachments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'Invalid attachments format' };
    }
    const attachment = item as Record<string, unknown>;
    const hasInlineData = typeof attachment.data === 'string';
    const hasStoredPath = typeof attachment.path === 'string';
    if (
      typeof attachment.name !== 'string' ||
      typeof attachment.mimeType !== 'string' ||
      hasInlineData === hasStoredPath
    ) {
      return { error: 'Invalid attachments format' };
    }
    if (hasInlineData) {
      attachments.push({
        name: attachment.name.slice(0, 255),
        mimeType: attachment.mimeType,
        data: attachment.data as string,
      });
    } else {
      if ((attachment.path as string).length > 600) {
        return { error: 'Invalid attachments format' };
      }
      attachments.push({
        name: attachment.name.slice(0, 255),
        mimeType: attachment.mimeType,
        path: attachment.path as string,
      });
    }
  }

  // Older paid-chat sessions legitimately have no linked diagnosis. The
  // browser serializes that state as null, so treat null like an omitted code
  // while continuing to reject malformed non-null values.
  let diagnosisCode: string | undefined;
  if (body.diagnosisCode !== undefined && body.diagnosisCode !== null) {
    if (
      typeof body.diagnosisCode !== 'string' ||
      !DIAGNOSIS_CODE_PATTERN.test(body.diagnosisCode)
    ) {
      return { error: 'Invalid diagnosis code' };
    }
    diagnosisCode = body.diagnosisCode;
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { error: 'Invalid stream option' };
  }

  const sessionId = body.sessionId ?? body.session_id;
  if (
    sessionId !== undefined &&
    (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId))
  ) {
    return { error: 'Invalid session ID' };
  }

  return {
    body: {
      messages,
      diagnosisCode,
      attachments,
      stream: body.stream as boolean | undefined,
      sessionId:
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
      session_id:
        typeof body.session_id === 'string' ? body.session_id : undefined,
    },
  };
}
