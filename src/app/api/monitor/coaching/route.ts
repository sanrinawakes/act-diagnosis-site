import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sendCoachingAlert } from '@/lib/coaching-alerts';
import {
  buildCoachingMonitorRunRecord,
  COACHING_MONITOR_PATH,
  persistCoachingMonitorRun,
  recoverStaleCoachingMonitorRuns,
  type StaleCoachingMonitorRun,
  updateCoachingMonitorAlertDelivery,
} from '@/lib/coaching-monitor-runs';
import { assertHealthyCoachingMonitorResult } from '@/lib/coaching-monitor-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const maxTotalMs = Number(process.env.COACHING_MONITOR_MAX_MS || 15000);
const maxFirstChunkMs = Number(
  process.env.COACHING_MONITOR_MAX_FIRST_CHUNK_MS || 10000
);
const MONITOR_STAGE_TIMEOUT_MS = 10000;
const MONITOR_HISTORY_PAIRS = 40;
const MONITOR_CHAT_TIMEOUT_MS = Math.max(
  5000,
  Math.min(45000, maxTotalMs + 5000)
);

type MonitorResult = {
  status: number;
  inputMessages: number;
  storedMessagesBeforeReply: number;
  storedMessagesAfterReply: number;
  payloadBytes: number;
  signInMs: number;
  profileMs: number;
  sessionCreateMs: number;
  userMessageSaveMs: number;
  historyLoadMs: number;
  firstChunkMs: number | null;
  doneMs: number | null;
  chatTotalMs: number;
  journeyTotalMs: number;
  assistantSaveMs: number;
  reloadMs: number;
  hasDone: boolean;
  outputChars: number;
  returnedFallback: boolean;
  provider: string;
  fallbackFrom: string | null;
  completionStatus: string | null;
  finalizationStatus: string | null;
  remaining: number | null;
  cookieAuthUsed: boolean;
  diagnosisCodeProvided: boolean;
};

type MonitorMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type CookieRecord = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const baseUrl = getBaseUrl(request);
  const monitorRunId = randomUUID();
  const checkedAt = new Date().toISOString();
  let monitorResult: MonitorResult | null = null;
  let staleMonitorRuns: StaleCoachingMonitorRun[] = [];
  let staleRecoveryAttempts = 0;
  let staleRecoveryError: string | null = null;
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const authError = validateMonitorAuthorization(request);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    await persistCoachingMonitorRun(
      supabaseAdmin,
      buildCoachingMonitorRunRecord({
        id: monitorRunId,
        status: 'running',
        baseUrl,
        checkedAt,
        elapsedMs: 0,
        result: null,
      })
    );

    monitorResult = await runPaidCoachingMonitor({
      baseUrl,
      supabaseAdmin,
    });
    assertHealthyCoachingMonitorResult(monitorResult, {
      maxFirstChunkMs,
      maxTotalMs,
    });

    const elapsedMs = Date.now() - startedAt;
    await persistCoachingMonitorRun(
      supabaseAdmin,
      buildCoachingMonitorRunRecord({
        id: monitorRunId,
        status: 'success',
        baseUrl,
        checkedAt,
        elapsedMs,
        result: monitorResult,
      })
    );

    const staleRecovery = await recoverStaleCoachingMonitorRuns(supabaseAdmin);
    staleMonitorRuns = staleRecovery.runs;
    staleRecoveryAttempts = staleRecovery.attempts;
    staleRecoveryError = staleRecovery.error;

    console.info(
      JSON.stringify({
        event: 'coaching_monitor_succeeded',
        route: '/api/monitor/coaching',
        monitorPath: COACHING_MONITOR_PATH,
        monitorRunId,
        checkedAt,
        staleRecoveryAttempts,
        staleRecoveryStatus: staleRecoveryError ? 'failed' : 'complete',
        staleRecoveryError,
        ...monitorResult,
      })
    );

    if (staleRecoveryError) {
      await notifyStaleRecoveryFailure({
        supabaseAdmin,
        monitorRunId,
        attempts: staleRecoveryAttempts,
        error: staleRecoveryError,
        monitorResult,
      });
    } else if (staleMonitorRuns.length > 0) {
      await notifyStaleMonitorRuns({
        supabaseAdmin,
        staleMonitorRuns,
        currentMonitorRunId: monitorRunId,
      });
    }

    return NextResponse.json(
      {
        ok: true,
        monitorRunId,
        checkedAt,
        elapsedMs,
        result: monitorResult,
        maintenance: {
          staleRecoveryAttempts,
          staleRecoveryStatus: staleRecoveryError ? 'failed' : 'complete',
          staleRecoveryError,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const rootError = error instanceof Error ? error.message : String(error);
    let monitorPersisted = false;
    let monitorPersistenceError: string | null = null;

    try {
      await persistCoachingMonitorRun(
        supabaseAdmin,
        buildCoachingMonitorRunRecord({
          id: monitorRunId,
          status: 'failure',
          baseUrl,
          checkedAt,
          elapsedMs: Date.now() - startedAt,
          result: monitorResult,
          error: rootError,
        })
      );
      monitorPersisted = true;
    } catch (persistenceError) {
      monitorPersistenceError =
        persistenceError instanceof Error
          ? persistenceError.message
          : String(persistenceError);
    }

    const details = {
      event: 'coaching_monitor_failed',
      route: '/api/monitor/coaching',
      monitorPath: COACHING_MONITOR_PATH,
      baseUrl,
      elapsedMs: Date.now() - startedAt,
      monitorRunId,
      monitorPersisted,
      monitorPersistenceError,
      staleMonitorRunIds: staleMonitorRuns.map((run) => run.id),
      error: rootError,
    };

    console.error(JSON.stringify(details));
    const alertDelivery = await sendCoachingAlert({
      subject: '[ACTI Bot] 定期監視で異常を検知しました',
      summary:
        '有料会員と同じログインCookie・履歴保存・AI送信・返信保存の定期監視で異常を検知しました。',
      details,
    });
    if (monitorPersisted) {
      try {
        await updateCoachingMonitorAlertDelivery(supabaseAdmin, [
          monitorRunId,
          ...staleMonitorRuns.map((run) => run.id),
        ], alertDelivery);
      } catch (alertPersistenceError) {
        console.error(
          JSON.stringify({
            event: 'coaching_monitor_alert_persistence_failed',
            monitorRunId,
            error:
              alertPersistenceError instanceof Error
                ? alertPersistenceError.message
                : String(alertPersistenceError),
          })
        );
      }
    }
    console.info(
      JSON.stringify({
        event: 'coaching_monitor_alert_delivery',
        accepted: alertDelivery.accepted,
        status: alertDelivery.status || null,
        resendId: alertDelivery.id || null,
        reason: alertDelivery.reason || null,
      })
    );

    return NextResponse.json(
      {
        ok: false,
        monitorRunId,
        checkedAt,
        elapsedMs: Date.now() - startedAt,
        error: details.error,
        alertAccepted: alertDelivery.accepted,
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

async function notifyStaleRecoveryFailure(params: {
  supabaseAdmin: SupabaseClient;
  monitorRunId: string;
  attempts: number;
  error: string;
  monitorResult: MonitorResult;
}) {
  const details = {
    event: 'coaching_monitor_maintenance_failed',
    route: '/api/monitor/coaching',
    monitorPath: COACHING_MONITOR_PATH,
    monitorRunId: params.monitorRunId,
    attempts: params.attempts,
    error: params.error,
    userJourneyStatus: 'success',
    httpStatus: params.monitorResult.status,
    hasDone: params.monitorResult.hasDone,
    completionStatus: params.monitorResult.completionStatus,
    finalizationStatus: params.monitorResult.finalizationStatus,
  };
  console.error(JSON.stringify(details));

  const alertDelivery = await sendCoachingAlert({
    subject: '[ACTI Bot] 定期監視の記録整理で異常を検知しました',
    summary:
      '有料会員と同じAIコーチング経路は正常に完了しましたが、過去の監視記録を整理する補助処理が再試行後も完了しませんでした。利用者の会話エラーを検知した通知ではありません。',
    details,
  });

  try {
    await updateCoachingMonitorAlertDelivery(
      params.supabaseAdmin,
      [params.monitorRunId],
      alertDelivery
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'coaching_monitor_maintenance_alert_persistence_failed',
        monitorRunId: params.monitorRunId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  console.info(
    JSON.stringify({
      event: 'coaching_monitor_maintenance_alert_delivery',
      monitorRunId: params.monitorRunId,
      accepted: alertDelivery.accepted,
      status: alertDelivery.status || null,
      resendId: alertDelivery.id || null,
      reason: alertDelivery.reason || null,
    })
  );
}

async function notifyStaleMonitorRuns(params: {
  supabaseAdmin: SupabaseClient;
  staleMonitorRuns: StaleCoachingMonitorRun[];
  currentMonitorRunId: string;
}) {
  const details = {
    event: 'coaching_monitor_stale_runs_recovered',
    route: '/api/monitor/coaching',
    monitorPath: COACHING_MONITOR_PATH,
    currentMonitorRunId: params.currentMonitorRunId,
    staleMonitorRuns: params.staleMonitorRuns,
  };
  console.error(JSON.stringify(details));

  const alertDelivery = await sendCoachingAlert({
    subject: '[ACTI Bot] 前回の定期監視が完了しませんでした',
    summary:
      '前回のAIコーチング定期監視が完了記録を残さず中断していたため、次の定期監視で検知しました。',
    details,
  });

  try {
    await updateCoachingMonitorAlertDelivery(
      params.supabaseAdmin,
      params.staleMonitorRuns.map((run) => run.id),
      alertDelivery
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'coaching_monitor_stale_alert_persistence_failed',
        monitorRunIds: params.staleMonitorRuns.map((run) => run.id),
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  console.info(
    JSON.stringify({
      event: 'coaching_monitor_stale_alert_delivery',
      monitorRunIds: params.staleMonitorRuns.map((run) => run.id),
      accepted: alertDelivery.accepted,
      status: alertDelivery.status || null,
      resendId: alertDelivery.id || null,
      reason: alertDelivery.reason || null,
    })
  );
}

async function runPaidCoachingMonitor(params: {
  baseUrl: string;
  supabaseAdmin: SupabaseClient;
}): Promise<MonitorResult> {
  const email = process.env.COACHING_MONITOR_EMAIL?.trim() || '';
  const password = process.env.COACHING_MONITOR_PASSWORD || '';
  if (!email || !password) {
    throw new Error('paid monitor credentials are not configured');
  }

  const startedAt = Date.now();
  const cookieJar = new Map<string, CookieRecord>();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return Array.from(cookieJar.values()).map(({ name, value }) => ({
          name,
          value,
        }));
      },
      setAll(
        cookiesToSet: Array<{
          name: string;
          value: string;
          options?: Record<string, unknown>;
        }>
      ) {
        cookiesToSet.forEach((cookie) => cookieJar.set(cookie.name, cookie));
      },
    },
  });

  let sessionId: string | null = null;
  try {
    const signInStartedAt = Date.now();
    const signIn = await withMonitorTimeout(
      authClient.auth.signInWithPassword({ email, password }),
      MONITOR_STAGE_TIMEOUT_MS,
      'sign-in'
    );
    if (signIn.error || !signIn.data.user || !signIn.data.session?.access_token) {
      throw new Error(
        `paid monitor sign-in failed: ${signIn.error?.message || 'no session'}`
      );
    }
    const signInMs = Date.now() - signInStartedAt;
    const userId = signIn.data.user.id;
    const accessToken = signIn.data.session.access_token;
    const cookieHeader = Array.from(cookieJar.values())
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    if (!cookieHeader) {
      throw new Error('paid monitor sign-in did not produce auth cookies');
    }

    const profileStartedAt = Date.now();
    const { data: profile, error: profileError } = await withMonitorTimeout(
      params.supabaseAdmin
        .from('profiles')
        .select('role, subscription_status, is_active')
        .eq('id', userId)
        .single(),
      MONITOR_STAGE_TIMEOUT_MS,
      'profile'
    );
    if (profileError || !profile) {
      throw new Error(
        `paid monitor profile failed: ${profileError?.message || 'not found'}`
      );
    }
    if (
      profile.role !== 'member' ||
      profile.subscription_status !== 'active' ||
      profile.is_active !== true
    ) {
      throw new Error('paid monitor profile is not an active paid member');
    }

    const today = new Date().toISOString().split('T')[0];
    const { error: resetError } = await params.supabaseAdmin
      .from('profiles')
      .update({ chat_count_today: 0, last_chat_date: today })
      .eq('id', userId);
    if (resetError) {
      throw new Error(`paid monitor count reset failed: ${resetError.message}`);
    }
    const profileMs = Date.now() - profileStartedAt;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const settingsResult = await withMonitorTimeout(
      userClient.from('site_settings').select('bot_enabled').single(),
      MONITOR_STAGE_TIMEOUT_MS,
      'settings'
    );
    if (settingsResult.error || settingsResult.data?.bot_enabled !== true) {
      throw new Error(
        `paid monitor settings failed: ${
          settingsResult.error?.message || 'bot is disabled'
        }`
      );
    }

    const sessionStartedAt = Date.now();
    const { data: createdSession, error: sessionError } =
      await withMonitorTimeout(
        userClient
          .from('chat_sessions')
          .insert({ user_id: userId, title: 'ACTI定期監視' })
          .select('id')
          .single(),
        MONITOR_STAGE_TIMEOUT_MS,
        'session-create'
      );
    if (sessionError || !createdSession) {
      throw new Error(
        `paid monitor session create failed: ${
          sessionError?.message || 'no session'
        }`
      );
    }
    sessionId = createdSession.id;
    const sessionCreateMs = Date.now() - sessionStartedAt;

    const allMessages = buildMonitorMessages();
    const storedRows = allMessages.map((message, index) => ({
      id: randomUUID(),
      session_id: sessionId,
      role: message.role,
      content: message.content,
      created_at: new Date(Date.now() - (allMessages.length - index) * 1000).toISOString(),
    }));
    const userMessageStartedAt = Date.now();
    const { error: messageInsertError } = await withMonitorTimeout(
      userClient.from('chat_messages').insert(storedRows),
      MONITOR_STAGE_TIMEOUT_MS,
      'user-message-save'
    );
    if (messageInsertError) {
      throw new Error(
        `paid monitor user message save failed: ${messageInsertError.message}`
      );
    }
    const userMessageSaveMs = Date.now() - userMessageStartedAt;

    const historyStartedAt = Date.now();
    const { data: recentRows, error: historyError } = await withMonitorTimeout(
      userClient
        .from('chat_messages')
        .select('role, content, created_at')
        .eq('session_id', sessionId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(24),
      MONITOR_STAGE_TIMEOUT_MS,
      'history-load'
    );
    if (historyError || !recentRows?.length) {
      throw new Error(
        `paid monitor history load failed: ${historyError?.message || 'empty'}`
      );
    }
    const apiMessages = recentRows
      .slice()
      .reverse()
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: String(message.content || ''),
      }));
    const historyLoadMs = Date.now() - historyStartedAt;

    const body = {
      sessionId,
      requestId: storedRows[storedRows.length - 1].id,
      assistantMessageId: randomUUID(),
      diagnosisCode: null,
      messages: apiMessages,
      stream: true,
    };
    const payloadBytes = Buffer.byteLength(JSON.stringify(body));
    const chatStartedAt = Date.now();
    const response = await fetch(`${params.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        Cookie: cookieHeader,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(MONITOR_CHAT_TIMEOUT_MS),
    });

    const streamResult = await readMonitorStream(response, chatStartedAt);

    const assistantSaveStartedAt = Date.now();
    const { data: savedAssistant, error: assistantSaveError } =
      await withMonitorTimeout(
        userClient
          .from('chat_messages')
          .select('id, role, content')
          .eq('id', body.assistantMessageId)
          .eq('session_id', sessionId)
          .maybeSingle(),
        MONITOR_STAGE_TIMEOUT_MS,
        'assistant-save'
      );
    if (
      assistantSaveError ||
      savedAssistant?.role !== 'assistant' ||
      savedAssistant.content !== streamResult.message
    ) {
      throw new Error(
        `paid monitor assistant save failed: ${
          assistantSaveError?.message || 'server response was not persisted'
        }`
      );
    }
    const assistantSaveMs = Date.now() - assistantSaveStartedAt;

    const reloadStartedAt = Date.now();
    const { data: reloadedRows, count, error: reloadError } =
      await withMonitorTimeout(
        userClient
          .from('chat_messages')
          .select('role, content', { count: 'exact' })
          .eq('session_id', sessionId)
          .order('created_at', { ascending: false })
          .limit(2),
        MONITOR_STAGE_TIMEOUT_MS,
        'history-reload'
      );
    if (reloadError) {
      throw new Error(`paid monitor history reload failed: ${reloadError.message}`);
    }
    if (
      count !== allMessages.length + 1 ||
      reloadedRows?.[0]?.role !== 'assistant' ||
      reloadedRows[0].content !== streamResult.message
    ) {
      throw new Error(
        `paid monitor persistence mismatch: expected ${
          allMessages.length + 1
        } rows, received ${count ?? 'unknown'}`
      );
    }
    const reloadMs = Date.now() - reloadStartedAt;

    return {
      status: response.status,
      inputMessages: apiMessages.length,
      storedMessagesBeforeReply: allMessages.length,
      storedMessagesAfterReply: count,
      payloadBytes,
      signInMs,
      profileMs,
      sessionCreateMs,
      userMessageSaveMs,
      historyLoadMs,
      firstChunkMs: streamResult.firstChunkMs,
      doneMs: streamResult.doneMs,
      chatTotalMs: streamResult.totalMs,
      journeyTotalMs: Date.now() - startedAt,
      assistantSaveMs,
      reloadMs,
      hasDone: streamResult.hasDone,
      outputChars: streamResult.message.length,
      returnedFallback: streamResult.returnedFallback,
      provider: streamResult.provider,
      fallbackFrom: streamResult.fallbackFrom,
      completionStatus: streamResult.completionStatus,
      finalizationStatus: streamResult.finalizationStatus,
      remaining: streamResult.remaining,
      cookieAuthUsed: true,
      diagnosisCodeProvided: false,
    };
  } finally {
    if (sessionId) {
      const { error } = await withMonitorTimeout(
        params.supabaseAdmin.from('chat_sessions').delete().eq('id', sessionId),
        MONITOR_STAGE_TIMEOUT_MS,
        'session-cleanup'
      );
      if (error) {
        throw new Error(`paid monitor session cleanup failed: ${error.message}`);
      }
    }
  }
}

async function readMonitorStream(response: Response, startedAt: number) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `paid coaching monitor failed ${response.status}: ${text.slice(0, 500)}`
    );
  }
  if (!response.body) {
    throw new Error('paid coaching monitor did not return a stream body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let message = '';
  let firstChunkMs: number | null = null;
  let doneMs: number | null = null;
  let donePayload: Record<string, unknown> | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const event = parseEventLine(line);
      if (!event && line.trim()) {
        throw new Error('paid coaching monitor received malformed stream data');
      }
      if (!event) continue;
      if (event.type === 'chunk' && typeof event.text === 'string') {
        firstChunkMs ??= Date.now() - startedAt;
        message += event.text;
      }
      if (event.type === 'done') {
        doneMs = Date.now() - startedAt;
        donePayload = event;
        if (typeof event.message === 'string') message = event.message;
      }
      if (event.type === 'error') {
        throw new Error(
          `paid coaching monitor stream error: ${String(
            event.error || 'unknown'
          )}`
        );
      }
    }
  }

  const trailingEvent = parseEventLine(buffer);
  if (!trailingEvent && buffer.trim()) {
    throw new Error('paid coaching monitor received malformed trailing data');
  }
  if (trailingEvent?.type === 'done') {
    doneMs = Date.now() - startedAt;
    donePayload = trailingEvent;
    if (typeof trailingEvent.message === 'string') message = trailingEvent.message;
  }

  return {
    firstChunkMs,
    doneMs,
    totalMs: Date.now() - startedAt,
    hasDone: Boolean(donePayload),
    message,
    returnedFallback:
      /応答に時間がかかりすぎ|応答に失敗|中断しました/.test(message) ||
      typeof donePayload?.fallbackFrom === 'string' ||
      (typeof donePayload?.provider === 'string' &&
        donePayload.provider !== 'gemini') ||
      donePayload?.completionStatus !== 'complete',
    provider:
      typeof donePayload?.provider === 'string'
        ? donePayload.provider
        : 'gemini',
    fallbackFrom:
      typeof donePayload?.fallbackFrom === 'string'
        ? donePayload.fallbackFrom
        : null,
    completionStatus:
      typeof donePayload?.completionStatus === 'string'
        ? donePayload.completionStatus
        : null,
    finalizationStatus:
      typeof donePayload?.finalizationStatus === 'string'
        ? donePayload.finalizationStatus
        : null,
    remaining:
      typeof donePayload?.remaining === 'number' ? donePayload.remaining : null,
  };
}

function validateMonitorAuthorization(request: NextRequest) {
  const expectedSecret =
    process.env.MONITORING_CRON_SECRET || process.env.CRON_SECRET || '';
  if (!expectedSecret) return 'Monitoring secret is not configured';

  const authHeader = request.headers.get('authorization') || '';
  if (authHeader === `Bearer ${expectedSecret}`) {
    return '';
  }
  return 'Unauthorized';
}

function getBaseUrl(request: NextRequest) {
  const requestOrigin = new URL(request.url).origin;
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(requestOrigin)) {
    return requestOrigin;
  }
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return requestOrigin;
}

function withMonitorTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`paid monitor ${label} timed out`)),
      timeoutMs
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
    clearTimeout(timeoutId)
  );
}

function buildMonitorMessages(): MonitorMessage[] {
  const messages: MonitorMessage[] = [];
  for (let index = 0; index < MONITOR_HISTORY_PAIRS; index += 1) {
    messages.push({
      role: 'user',
      content: `定期監視用の過去文脈です ${index}。仕事の悩み、人間関係、明日の一歩について相談しています。`,
    });
    messages.push({
      role: 'assistant',
      content: `受け止めました ${index}。今は焦らず、一つずつ整理していきましょう。`,
    });
  }
  messages.push({
    role: 'user',
    content:
      '定期監視です。明日まず何をすればいいか、一つだけ短く自然に返してください。',
  });
  return messages;
}

function parseEventLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    if (!['chunk', 'done', 'error'].includes(String(event.type || ''))) {
      return null;
    }
    return event;
  } catch {
    return null;
  }
}
