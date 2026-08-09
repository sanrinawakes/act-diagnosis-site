import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FREE_DAILY_COACHING_LIMIT,
  releaseFreeDailyQuota,
  reserveFreeDailyQuota,
} from '../src/lib/free-coaching-quota';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-08-08';

describe('free coaching daily quota RPC contract', () => {
  it('reserves the authoritative daily slot before model generation', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: true,
          usage_count: FREE_DAILY_COACHING_LIMIT,
          remaining: 0,
          reserved_now: true,
        },
      ],
      error: null,
    });

    await expect(
      reserveFreeDailyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        day: DAY,
      })
    ).resolves.toEqual({
      allowed: true,
      used: FREE_DAILY_COACHING_LIMIT,
      remaining: 0,
      reservedNow: true,
      day: DAY,
      limit: FREE_DAILY_COACHING_LIMIT,
      requestId: REQUEST_ID,
    });
    expect(rpc).toHaveBeenCalledWith('reserve_free_coaching_daily_usage', {
      p_user_id: USER_ID,
      p_request_id: REQUEST_ID,
      p_usage_day: DAY,
      p_limit: FREE_DAILY_COACHING_LIMIT,
    });
  });

  it('fails closed when the database denies a concurrent over-limit request', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: false,
          usage_count: FREE_DAILY_COACHING_LIMIT,
          remaining: 0,
          reserved_now: false,
        },
      ],
      error: null,
    });

    await expect(
      reserveFreeDailyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        day: DAY,
      })
    ).resolves.toMatchObject({
      allowed: false,
      used: FREE_DAILY_COACHING_LIMIT,
      remaining: 0,
    });
  });

  it('uses the same request identifier to return a failed non-stream request slot', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ released: true, usage_count: 2, remaining: 1 }],
      error: null,
    });

    await expect(
      releaseFreeDailyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        day: DAY,
      })
    ).resolves.toEqual({
      released: true,
      used: 2,
      remaining: 1,
      day: DAY,
      limit: FREE_DAILY_COACHING_LIMIT,
    });
    expect(rpc).toHaveBeenCalledWith('release_free_coaching_daily_usage', {
      p_user_id: USER_ID,
      p_request_id: REQUEST_ID,
      p_usage_day: DAY,
      p_limit: FREE_DAILY_COACHING_LIMIT,
    });
  });

  it('fails closed when the RPC response is missing', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(
      reserveFreeDailyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        day: DAY,
      })
    ).rejects.toThrow('FREE_DAILY_QUOTA_RESULT_MISSING');
  });
});

function createClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient;
}
