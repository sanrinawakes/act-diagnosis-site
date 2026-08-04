import type { SupabaseClient } from '@supabase/supabase-js';
import { getJapanMonthStartKey } from '@/lib/japan-date';

export const MONTHLY_COACHING_LIMIT = 1500;

type MonthlyQuotaProfile = {
  role?: string | null;
  chat_count_month?: number | null;
  chat_month_start?: string | null;
};

export type MonthlyQuotaState = {
  periodStart: string;
  used: number;
  remaining: number;
  limit: number;
};

export type MonthlyQuotaReservation = MonthlyQuotaState & {
  allowed: boolean;
  reservedNow: boolean;
  requestId: string;
};

export function getMonthlyQuotaState(
  profile: MonthlyQuotaProfile,
  now = new Date()
): MonthlyQuotaState {
  const periodStart = getJapanMonthStartKey(now);
  const used =
    profile.chat_month_start === periodStart
      ? normalizeUsageCount(profile.chat_count_month)
      : 0;

  return {
    periodStart,
    used,
    remaining:
      profile.role === 'admin'
        ? MONTHLY_COACHING_LIMIT
        : Math.max(0, MONTHLY_COACHING_LIMIT - used),
    limit: MONTHLY_COACHING_LIMIT,
  };
}

export function buildMonthlyQuotaError(limit = MONTHLY_COACHING_LIMIT) {
  return `今月の利用上限（${limit}回）に達しました。翌月1日から再びご利用いただけます。`;
}

export async function reserveMonthlyQuota(params: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  requestId: string;
  periodStart: string;
  limit?: number;
}): Promise<MonthlyQuotaReservation> {
  const limit = params.limit ?? MONTHLY_COACHING_LIMIT;
  const { data, error } = await params.supabaseAdmin.rpc(
    'reserve_coaching_monthly_usage',
    {
      p_user_id: params.userId,
      p_request_id: params.requestId,
      p_period_start: params.periodStart,
      p_limit: limit,
    }
  );

  if (error) {
    throw new Error(`MONTHLY_QUOTA_RESERVE_FAILED: ${error.message}`);
  }

  const row = readRpcRow(data);
  return {
    allowed: row.allowed === true,
    used: normalizeUsageCount(row.usage_count),
    remaining: normalizeUsageCount(row.remaining),
    reservedNow: row.reserved_now === true,
    periodStart: params.periodStart,
    limit,
    requestId: params.requestId,
  };
}

export async function releaseMonthlyQuota(params: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  requestId: string;
  periodStart: string;
  limit?: number;
}) {
  const limit = params.limit ?? MONTHLY_COACHING_LIMIT;
  const { data, error } = await params.supabaseAdmin.rpc(
    'release_coaching_monthly_usage',
    {
      p_user_id: params.userId,
      p_request_id: params.requestId,
      p_period_start: params.periodStart,
      p_limit: limit,
    }
  );

  if (error) {
    throw new Error(`MONTHLY_QUOTA_RELEASE_FAILED: ${error.message}`);
  }

  const row = readRpcRow(data);
  return {
    released: row.released === true,
    used: normalizeUsageCount(row.usage_count),
    remaining: normalizeUsageCount(row.remaining),
    periodStart: params.periodStart,
    limit,
  };
}

function readRpcRow(data: unknown): Record<string, unknown> {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('MONTHLY_QUOTA_RESULT_MISSING');
  }
  return row as Record<string, unknown>;
}

function normalizeUsageCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
