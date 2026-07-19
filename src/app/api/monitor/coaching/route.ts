import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sendCoachingAlert } from '@/lib/coaching-alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const maxTotalMs = Number(process.env.COACHING_MONITOR_MAX_MS || 15000);
const maxFirstChunkMs = Number(
  process.env.COACHING_MONITOR_MAX_FIRST_CHUNK_MS || 10000
);

type MonitorResult = {
  status: number;
  inputMessages: number;
  payloadBytes: number;
  firstChunkMs: number | null;
  doneMs: number | null;
  totalMs: number;
  hasDone: boolean;
  outputChars: number;
  returnedFallback: boolean;
  remaining: number | null;
};

type PaidDependencyResult = {
  settingsMs: number;
  profilesMs: number;
  sessionsMs: number;
  messagesMs: number | null;
  sampledSession: boolean;
};

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const email = uniqueMonitorEmail();
  const baseUrl = getBaseUrl(request);
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    const authError = validateMonitorAuthorization(request);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    const [result, paidDependencies] = await Promise.all([
      runCoachingMonitor({
        baseUrl,
        email,
      }),
      runPaidDependencyMonitor(supabase),
    ]);

    assertHealthyMonitorResult(result);

    return NextResponse.json(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        result,
        paidDependencies,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const details = {
      event: 'coaching_monitor_failed',
      route: '/api/monitor/coaching',
      baseUrl,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };

    console.error(JSON.stringify(details));
    await sendCoachingAlert({
      subject: '[ACTI Bot] 定期監視で異常を検知しました',
      summary:
        'AIコーチングbotの定期監視で、遅延・失敗・stream未完了のいずれかを検知しました。',
      details,
    });

    return NextResponse.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: details.error,
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  } finally {
    await supabase.from('free_users').delete().eq('email', email);
  }
}

async function runPaidDependencyMonitor(
  supabase: SupabaseClient
): Promise<PaidDependencyResult> {
  const [settings, profiles, sessions] = await Promise.all([
    runTimedDependencyQuery(
      'site_settings',
      supabase.from('site_settings').select('bot_enabled').limit(1)
    ),
    runTimedDependencyQuery(
      'profiles',
      supabase.from('profiles').select('id').limit(1)
    ),
    runTimedDependencyQuery(
      'chat_sessions',
      supabase
        .from('chat_sessions')
        .select('id')
        .order('updated_at', { ascending: false })
        .limit(1)
    ),
  ]);

  if (settings.data?.[0]?.bot_enabled === false) {
    throw new Error('paid dependency monitor: coaching bot is disabled');
  }

  const sessionId = sessions.data?.[0]?.id;
  let messagesMs: number | null = null;
  if (sessionId) {
    const messages = await runTimedDependencyQuery(
      'chat_messages',
      supabase
        .from('chat_messages')
        .select('id')
        .eq('session_id', sessionId)
        .limit(1)
    );
    messagesMs = messages.elapsedMs;
  }

  return {
    settingsMs: settings.elapsedMs,
    profilesMs: profiles.elapsedMs,
    sessionsMs: sessions.elapsedMs,
    messagesMs,
    sampledSession: Boolean(sessionId),
  };
}

async function runTimedDependencyQuery<T>(
  label: string,
  query: PromiseLike<{ data: T; error: { message?: string } | null }>
) {
  const startedAt = Date.now();
  const result = await withMonitorTimeout(query, 8000, label);
  if (result.error) {
    throw new Error(
      `paid dependency monitor ${label} failed: ${result.error.message || 'unknown error'}`
    );
  }

  return {
    data: result.data,
    elapsedMs: Date.now() - startedAt,
  };
}

function withMonitorTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`paid dependency monitor ${label} timed out`)),
      timeoutMs
    );
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
    clearTimeout(timeoutId)
  );
}

function validateMonitorAuthorization(request: NextRequest) {
  const expectedSecret =
    process.env.MONITORING_CRON_SECRET || process.env.CRON_SECRET || '';

  if (!expectedSecret) return '';

  const authHeader = request.headers.get('authorization') || '';
  const querySecret = new URL(request.url).searchParams.get('secret') || '';

  if (
    authHeader === `Bearer ${expectedSecret}` ||
    querySecret === expectedSecret
  ) {
    return '';
  }

  return 'Unauthorized';
}

function getBaseUrl(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return new URL(request.url).origin;
}

async function runCoachingMonitor(params: {
  baseUrl: string;
  email: string;
}): Promise<MonitorResult> {
  const messages = buildMonitorMessages();
  const body = {
    email: params.email,
    diagnosisCode: 'SMM-1',
    messages,
    stream: true,
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(body));
  const startedAt = Date.now();

  const response = await fetch(`${params.baseUrl}/api/free/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `free coaching monitor failed ${response.status}: ${text.slice(0, 500)}`
    );
  }

  if (!response.body) {
    throw new Error('free coaching monitor did not return a stream body');
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
      if (!event) continue;

      if (event.type === 'chunk' && typeof event.text === 'string') {
        firstChunkMs ??= Date.now() - startedAt;
        message += event.text;
      }

      if (event.type === 'done') {
        doneMs = Date.now() - startedAt;
        donePayload = event;
        if (typeof event.message === 'string') {
          message = event.message;
        }
      }

      if (event.type === 'error') {
        throw new Error(
          `free coaching monitor stream error: ${String(
            event.error || 'unknown'
          )}`
        );
      }
    }
  }

  const trailingEvent = parseEventLine(buffer);
  if (trailingEvent?.type === 'done') {
    doneMs = Date.now() - startedAt;
    donePayload = trailingEvent;
    if (typeof trailingEvent.message === 'string') {
      message = trailingEvent.message;
    }
  }

  return {
    status: response.status,
    inputMessages: messages.length,
    payloadBytes,
    firstChunkMs,
    doneMs,
    totalMs: Date.now() - startedAt,
    hasDone: Boolean(donePayload),
    outputChars: message.length,
    returnedFallback: /応答に時間がかかりすぎ|応答に失敗|中断しました/.test(
      message
    ),
    remaining:
      typeof donePayload?.remaining === 'number' ? donePayload.remaining : null,
  };
}

function assertHealthyMonitorResult(result: MonitorResult) {
  if (!result.hasDone) {
    throw new Error('monitor did not receive done event');
  }

  if (result.firstChunkMs === null || result.firstChunkMs > maxFirstChunkMs) {
    throw new Error(
      `monitor first chunk too slow: ${result.firstChunkMs}ms`
    );
  }

  if (result.totalMs > maxTotalMs) {
    throw new Error(`monitor total too slow: ${result.totalMs}ms`);
  }

  if (result.outputChars <= 0) {
    throw new Error(`monitor output too short: ${result.outputChars} chars`);
  }

  if (result.returnedFallback) {
    throw new Error('monitor returned fallback/error text');
  }
}

function buildMonitorMessages() {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (let index = 0; index < 40; index += 1) {
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
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function uniqueMonitorEmail() {
  return `codex-monitor-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}@example.com`;
}
