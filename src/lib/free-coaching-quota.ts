import type { SupabaseClient } from '@supabase/supabase-js';

export const FREE_DAILY_COACHING_LIMIT = 3;

export type FreeDailyQuotaReservation = {
  allowed: boolean;
  used: number;
  remaining: number;
  reservedNow: boolean;
  day: string;
  limit: number;
  requestId: string;
};

export async function reserveFreeDailyQuota(params: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  requestId: string;
  day: string;
  limit?: number;
}): Promise<FreeDailyQuotaReservation> {
  const limit = params.limit ?? FREE_DAILY_COACHING_LIMIT;
  const { data, error } = await params.supabaseAdmin.rpc(
    'reserve_free_coaching_daily_usage',
    {
      p_user_id: params.userId,
      p_request_id: params.requestId,
      p_usage_day: params.day,
      p_limit: limit,
    }
  );

  if (error) {
    throw new Error(`FREE_DAILY_QUOTA_RESERVE_FAILED: ${error.message}`);
  }

  const row = readRpcRow(data);
  return {
    allowed: row.allowed === true,
    used: normalizeUsageCount(row.usage_count),
    remaining: normalizeUsageCount(row.remaining),
    reservedNow: row.reserved_now === true,
    day: params.day,
    limit,
    requestId: params.requestId,
  };
}

export async function releaseFreeDailyQuota(params: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  requestId: string;
  day: string;
  limit?: number;
}) {
  const limit = params.limit ?? FREE_DAILY_COACHING_LIMIT;
  const { data, error } = await params.supabaseAdmin.rpc(
    'release_free_coaching_daily_usage',
    {
      p_user_id: params.userId,
      p_request_id: params.requestId,
      p_usage_day: params.day,
      p_limit: limit,
    }
  );

  if (error) {
    throw new Error(`FREE_DAILY_QUOTA_RELEASE_FAILED: ${error.message}`);
  }

  const row = readRpcRow(data);
  return {
    released: row.released === true,
    used: normalizeUsageCount(row.usage_count),
    remaining: normalizeUsageCount(row.remaining),
    day: params.day,
    limit,
  };
}

function readRpcRow(data: unknown): Record<string, unknown> {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('FREE_DAILY_QUOTA_RESULT_MISSING');
  }
  return row as Record<string, unknown>;
}

function normalizeUsageCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
