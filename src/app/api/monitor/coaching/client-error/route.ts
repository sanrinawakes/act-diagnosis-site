import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { sendCoachingAlert } from '@/lib/coaching-alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const AUTH_TIMEOUT_MS = 8000;
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_USER_AGENT_LENGTH = 300;
const alertLastSentAt = new Map<string, number>();

const CLIENT_FAILURE_STAGES = new Set([
  'prepare_attachments',
  'save_user_message',
  'load_history',
  'connect_chat',
  'read_stream',
  'save_response',
]);

type AuthResult = {
  status: 'authenticated' | 'unauthenticated' | 'timeout' | 'error';
  userId?: string;
  email?: string;
  error?: string;
};

export async function POST(request: NextRequest) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || !CLIENT_FAILURE_STAGES.has(body.stage)) {
    return NextResponse.json({ error: 'Invalid failure stage' }, { status: 400 });
  }

  const auth = await getAuthResult();
  const throttleActor = auth.userId || auth.status;
  const throttleKey = `${throttleActor}:${body.stage}`;
  const now = Date.now();
  const lastSentAt = alertLastSentAt.get(throttleKey) || 0;

  if (now - lastSentAt < ALERT_THROTTLE_MS) {
    return NextResponse.json({ accepted: true, alertSuppressed: true }, { status: 202 });
  }

  alertLastSentAt.set(throttleKey, now);
  pruneAlertThrottle(now);

  const details = {
    event: 'coaching_client_error',
    route: '/coaching',
    stage: body.stage,
    elapsedMs: toSafeNumber(body.elapsedMs),
    hadPartialResponse: body.hadPartialResponse === true,
    errorName: toSafeText(body.errorName, 80),
    errorMessage: toSafeText(body.errorMessage, MAX_ERROR_MESSAGE_LENGTH),
    sessionId: toSafeText(body.sessionId, 80),
    authStatus: auth.status,
    userId: auth.userId || null,
    userEmail: auth.email || null,
    authError: auth.error || null,
    userAgent: toSafeText(
      request.headers.get('user-agent'),
      MAX_USER_AGENT_LENGTH
    ),
    deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA || null,
  };

  console.error(JSON.stringify(details));
  const alertDelivery = await sendCoachingAlert({
    subject: '[ACTI Bot] 会員画面で送信失敗を検知しました',
    summary:
      '有料会員のAIコーチング画面で、利用者にエラーが表示されました。相談本文はこの通知に含めていません。',
    details,
  });

  console.info(
    JSON.stringify({
      event: 'coaching_client_error_alert_delivery',
      stage: body.stage,
      accepted: alertDelivery.accepted,
      status: alertDelivery.status || null,
      resendId: alertDelivery.id || null,
      reason: alertDelivery.reason || null,
    })
  );

  return NextResponse.json(
    {
      accepted: true,
      alertAccepted: alertDelivery.accepted,
    },
    { status: 202 }
  );
}

async function getAuthResult(): Promise<AuthResult> {
  try {
    const cookieStore = await cookies();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return { status: 'error', error: 'Supabase auth configuration is missing' };
    }

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Telemetry requests never need to update browser cookies.
        },
      },
    });

    const result = await withTimeout(
      supabase.auth.getUser(),
      AUTH_TIMEOUT_MS,
      'server auth timed out'
    );

    if (!result.data.user) {
      return {
        status: 'unauthenticated',
        error: result.error?.message,
      };
    }

    return {
      status: 'authenticated',
      userId: result.data.user.id,
      email: result.data.user.email,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: message === 'server auth timed out' ? 'timeout' : 'error',
      error: message,
    };
  }
}

function isAllowedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  const allowedOrigins = new Set([request.nextUrl.origin]);
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (configuredSiteUrl) {
    try {
      allowedOrigins.add(new URL(configuredSiteUrl).origin);
    } catch {
      // Ignore malformed optional configuration.
    }
  }

  return allowedOrigins.has(origin);
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
    clearTimeout(timeoutId)
  );
}

function toSafeText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function toSafeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function pruneAlertThrottle(now: number) {
  if (alertLastSentAt.size < 200) return;

  for (const [key, sentAt] of alertLastSentAt) {
    if (now - sentAt >= ALERT_THROTTLE_MS) {
      alertLastSentAt.delete(key);
    }
  }
}
