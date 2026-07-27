import type { SupabaseClient } from '@supabase/supabase-js';

export const COACHING_MONITOR_PATH = 'paid-cookie-auth-and-persistence';
export const COACHING_MONITOR_STALE_AFTER_MS = 2 * 60 * 1000;
export const COACHING_MONITOR_STALE_RECOVERY_ATTEMPTS = 2;
export const COACHING_MONITOR_STALE_RECOVERY_RETRY_MS = 250;
export const COACHING_MONITOR_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const MONITOR_PERSISTENCE_TIMEOUT_MS = 15000;
const MONITOR_PERSISTENCE_RETRY_ATTEMPTS = 2;
const MONITOR_PERSISTENCE_RETRY_DELAY_MS = 250;

export type CoachingMonitorMetrics = {
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
  memoryRefreshMs: number;
  memoryRefreshVerified: boolean;
  outputChars: number;
  returnedFallback: boolean;
  provider: string;
  fallbackFrom: string | null;
  completionStatus: string | null;
  finalizationStatus: string | null;
  hasDone: boolean;
  remaining: number | null;
  cookieAuthUsed: boolean;
};

type MonitorRunStatus = 'running' | 'success' | 'failure';

export type StaleCoachingMonitorRun = {
  id: string;
  checked_at: string;
};

export type StaleCoachingMonitorRecovery = {
  runs: StaleCoachingMonitorRun[];
  attempts: number;
  error: string | null;
};

export type RecentAcceptedMonitorFailureAlert = {
  id: string;
  checkedAt: string;
  resendId: string | null;
};

export type CoachingMonitorRunRecord = {
  id: string;
  status: MonitorRunStatus;
  monitor_path: string;
  base_url: string;
  deployment_commit: string | null;
  deployment_id: string | null;
  deployment_url: string | null;
  checked_at: string;
  elapsed_ms: number;
  http_status: number | null;
  input_messages: number | null;
  stored_messages_before_reply: number | null;
  stored_messages_after_reply: number | null;
  payload_bytes: number | null;
  first_chunk_ms: number | null;
  chat_total_ms: number | null;
  journey_total_ms: number | null;
  output_chars: number | null;
  returned_fallback: boolean | null;
  provider: string | null;
  fallback_from: string | null;
  completion_status: string | null;
  finalization_status: string | null;
  has_done: boolean | null;
  remaining: number | null;
  cookie_auth_used: boolean | null;
  stage_timings: Record<string, number | null>;
  error: string | null;
};

export function buildCoachingMonitorRunRecord(params: {
  id: string;
  status: MonitorRunStatus;
  baseUrl: string;
  checkedAt: string;
  elapsedMs: number;
  result: CoachingMonitorMetrics | null;
  error?: string | null;
}): CoachingMonitorRunRecord {
  const result = params.result;

  return {
    id: params.id,
    status: params.status,
    monitor_path: COACHING_MONITOR_PATH,
    base_url: params.baseUrl,
    deployment_commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null,
    deployment_url: process.env.VERCEL_URL || null,
    checked_at: params.checkedAt,
    elapsed_ms: params.elapsedMs,
    http_status: result?.status ?? null,
    input_messages: result?.inputMessages ?? null,
    stored_messages_before_reply: result?.storedMessagesBeforeReply ?? null,
    stored_messages_after_reply: result?.storedMessagesAfterReply ?? null,
    payload_bytes: result?.payloadBytes ?? null,
    first_chunk_ms: result?.firstChunkMs ?? null,
    chat_total_ms: result?.chatTotalMs ?? null,
    journey_total_ms: result?.journeyTotalMs ?? null,
    output_chars: result?.outputChars ?? null,
    returned_fallback: result?.returnedFallback ?? null,
    provider: result?.provider ?? null,
    fallback_from: result?.fallbackFrom ?? null,
    completion_status: result?.completionStatus ?? null,
    finalization_status: result?.finalizationStatus ?? null,
    has_done: result?.hasDone ?? null,
    remaining: result?.remaining ?? null,
    cookie_auth_used: result?.cookieAuthUsed ?? null,
    stage_timings: result
      ? {
          signInMs: result.signInMs,
          profileMs: result.profileMs,
          sessionCreateMs: result.sessionCreateMs,
          userMessageSaveMs: result.userMessageSaveMs,
          historyLoadMs: result.historyLoadMs,
          doneMs: result.doneMs,
          assistantSaveMs: result.assistantSaveMs,
          reloadMs: result.reloadMs,
          memoryRefreshMs: result.memoryRefreshMs,
          memoryRefreshVerified: result.memoryRefreshVerified ? 1 : 0,
        }
      : {},
    error: params.status === 'failure' ? params.error || 'unknown error' : null,
  };
}

export async function persistCoachingMonitorRun(
  supabaseAdmin: SupabaseClient,
  record: CoachingMonitorRunRecord
) {
  const response = await retryMonitorPersistence(
    () =>
      supabaseAdmin
        .from('coaching_monitor_runs')
        .upsert(record, { onConflict: 'id' })
        .abortSignal(AbortSignal.timeout(MONITOR_PERSISTENCE_TIMEOUT_MS)),
    'coaching monitor result persistence failed'
  );

  if (response.error) {
    throw new Error(
      `coaching monitor result persistence failed: ${response.error.message}`
    );
  }

  return String(record.id);
}

export async function failStaleCoachingMonitorRuns(
  supabaseAdmin: SupabaseClient,
  now = new Date()
): Promise<StaleCoachingMonitorRun[]> {
  const cutoff = new Date(
    now.getTime() - COACHING_MONITOR_STALE_AFTER_MS
  ).toISOString();
  let response;
  try {
    response = await supabaseAdmin
      .from('coaching_monitor_runs')
      .update({
        status: 'failure',
        elapsed_ms: COACHING_MONITOR_STALE_AFTER_MS,
        error: 'monitor invocation did not finalize before the next check',
      })
      .eq('status', 'running')
      .lt('checked_at', cutoff)
      .select('id, checked_at')
      .abortSignal(AbortSignal.timeout(MONITOR_PERSISTENCE_TIMEOUT_MS));
  } catch (error) {
    throw new Error(
      `stale coaching monitor recovery failed: ${getErrorMessage(error)}`
    );
  }

  if (response.error) {
    throw new Error(
      `stale coaching monitor recovery failed: ${response.error.message}`
    );
  }

  return (response.data || []).map((row) => ({
    id: String(row.id),
    checked_at: String(row.checked_at),
  }));
}

export async function recoverStaleCoachingMonitorRuns(
  supabaseAdmin: SupabaseClient,
  options: {
    now?: Date;
    maxAttempts?: number;
    retryDelayMs?: number;
  } = {}
): Promise<StaleCoachingMonitorRecovery> {
  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? COACHING_MONITOR_STALE_RECOVERY_ATTEMPTS
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? COACHING_MONITOR_STALE_RECOVERY_RETRY_MS
  );
  const now = options.now ?? new Date();
  let lastError = 'unknown stale coaching monitor recovery failure';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return {
        runs: await failStaleCoachingMonitorRuns(supabaseAdmin, now),
        attempts: attempt,
        error: null,
      };
    } catch (error) {
      lastError = getErrorMessage(error);
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await wait(retryDelayMs);
      }
    }
  }

  return {
    runs: [],
    attempts: maxAttempts,
    error: lastError,
  };
}

export async function updateCoachingMonitorAlertDelivery(
  supabaseAdmin: SupabaseClient,
  monitorRunIds: string[],
  delivery: {
    accepted: boolean;
    status?: number;
    id?: string;
    reason?: string;
  }
) {
  if (monitorRunIds.length === 0) return;

  let response;
  try {
    response = await supabaseAdmin
      .from('coaching_monitor_runs')
      .update({
        alert_accepted: delivery.accepted,
        alert_status: delivery.status ?? null,
        alert_resend_id: delivery.id ?? null,
        alert_reason: delivery.reason ?? null,
      })
      .in('id', monitorRunIds)
      .abortSignal(AbortSignal.timeout(MONITOR_PERSISTENCE_TIMEOUT_MS));
  } catch (error) {
    throw new Error(
      `coaching monitor alert persistence failed: ${getErrorMessage(error)}`
    );
  }

  const { error } = response;

  if (error) {
    throw new Error(
      `coaching monitor alert persistence failed: ${error.message}`
    );
  }
}

export async function findRecentAcceptedMonitorFailureAlert(
  supabaseAdmin: SupabaseClient,
  params: {
    error: string;
    checkedAt: string;
    excludeRunId: string;
    deploymentCommit?: string | null;
    cooldownMs?: number;
  }
): Promise<RecentAcceptedMonitorFailureAlert | null> {
  const checkedAtMs = new Date(params.checkedAt).getTime();
  if (!Number.isFinite(checkedAtMs)) {
    throw new Error('coaching monitor alert dedupe failed: invalid checkedAt');
  }

  const cooldownMs = Math.max(
    0,
    params.cooldownMs ?? COACHING_MONITOR_ALERT_COOLDOWN_MS
  );
  const cutoff = new Date(checkedAtMs - cooldownMs).toISOString();

  let query = supabaseAdmin
    .from('coaching_monitor_runs')
    .select('id, checked_at, alert_resend_id')
    .eq('monitor_path', COACHING_MONITOR_PATH)
    .eq('status', 'failure')
    .eq('error', params.error)
    .eq('alert_accepted', true)
    .gte('checked_at', cutoff)
    .lt('checked_at', params.checkedAt)
    .neq('id', params.excludeRunId);

  if (params.deploymentCommit) {
    query = query.eq('deployment_commit', params.deploymentCommit);
  }

  let response;
  try {
    response = await query
      .order('checked_at', { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(MONITOR_PERSISTENCE_TIMEOUT_MS))
      .maybeSingle();
  } catch (error) {
    throw new Error(
      `coaching monitor alert dedupe failed: ${getErrorMessage(error)}`
    );
  }

  if (response.error) {
    throw new Error(
      `coaching monitor alert dedupe failed: ${response.error.message}`
    );
  }
  if (!response.data) return null;

  return {
    id: String(response.data.id),
    checkedAt: String(response.data.checked_at),
    resendId: response.data.alert_resend_id
      ? String(response.data.alert_resend_id)
      : null,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function retryMonitorPersistence<T>(
  operation: () => PromiseLike<T> | T,
  label: string
) {
  let lastError: unknown = null;

  for (
    let attempt = 1;
    attempt <= MONITOR_PERSISTENCE_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await Promise.resolve(operation());
    } catch (error) {
      lastError = error;
      if (
        attempt < MONITOR_PERSISTENCE_RETRY_ATTEMPTS &&
        isRetryableMonitorPersistenceError(error)
      ) {
        await wait(MONITOR_PERSISTENCE_RETRY_DELAY_MS);
        continue;
      }

      throw new Error(`${label}: ${getErrorMessage(error)}`);
    }
  }

  throw new Error(`${label}: ${getErrorMessage(lastError)}`);
}

function isRetryableMonitorPersistenceError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
  );
}
