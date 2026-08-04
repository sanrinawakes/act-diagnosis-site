import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildMonthlyQuotaError,
  getMonthlyQuotaState,
  MONTHLY_COACHING_LIMIT,
  releaseMonthlyQuota,
  reserveMonthlyQuota,
} from '../src/lib/coaching-quota';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

describe('monthly coaching quota snapshot', () => {
  it('uses the stored count during the same Japanese calendar month', () => {
    expect(
      getMonthlyQuotaState(
        {
          role: 'member',
          chat_count_month: 1499,
          chat_month_start: '2026-08-01',
        },
        new Date('2026-08-31T14:59:59.999Z')
      )
    ).toEqual({
      periodStart: '2026-08-01',
      used: 1499,
      remaining: 1,
      limit: MONTHLY_COACHING_LIMIT,
    });
  });

  it('treats a previous-month counter as zero at Japan midnight on the first', () => {
    expect(
      getMonthlyQuotaState(
        {
          role: 'member',
          chat_count_month: 1500,
          chat_month_start: '2026-08-01',
        },
        new Date('2026-08-31T15:00:00.000Z')
      )
    ).toEqual({
      periodStart: '2026-09-01',
      used: 0,
      remaining: MONTHLY_COACHING_LIMIT,
      limit: MONTHLY_COACHING_LIMIT,
    });
  });

  it('never returns a negative remaining count', () => {
    expect(
      getMonthlyQuotaState(
        {
          role: 'member',
          chat_count_month: 1501,
          chat_month_start: '2026-08-01',
        },
        new Date('2026-08-10T00:00:00.000Z')
      ).remaining
    ).toBe(0);
  });

  it('keeps administrators outside the paid-member cap', () => {
    expect(
      getMonthlyQuotaState(
        {
          role: 'admin',
          chat_count_month: 1500,
          chat_month_start: '2026-08-01',
        },
        new Date('2026-08-10T00:00:00.000Z')
      ).remaining
    ).toBe(MONTHLY_COACHING_LIMIT);
  });

  it('explains both the cap and the reset date', () => {
    expect(buildMonthlyQuotaError()).toBe(
      '今月の利用上限（1500回）に達しました。翌月1日から再びご利用いただけます。'
    );
  });
});

describe('monthly coaching quota RPC contract', () => {
  it('reserves one request and returns the authoritative database count', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: true,
          usage_count: 1500,
          remaining: 0,
          reserved_now: true,
        },
      ],
      error: null,
    });

    await expect(
      reserveMonthlyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        periodStart: '2026-08-01',
      })
    ).resolves.toEqual({
      allowed: true,
      used: 1500,
      remaining: 0,
      reservedNow: true,
      periodStart: '2026-08-01',
      limit: 1500,
      requestId: REQUEST_ID,
    });
    expect(rpc).toHaveBeenCalledWith('reserve_coaching_monthly_usage', {
      p_user_id: USER_ID,
      p_request_id: REQUEST_ID,
      p_period_start: '2026-08-01',
      p_limit: 1500,
    });
  });

  it('reports the 1501st unique request as denied', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: false,
          usage_count: 1500,
          remaining: 0,
          reserved_now: false,
        },
      ],
      error: null,
    });

    await expect(
      reserveMonthlyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        periodStart: '2026-08-01',
      })
    ).resolves.toMatchObject({ allowed: false, used: 1500, remaining: 0 });
  });

  it('releases a failed request using the same idempotency key', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ released: true, usage_count: 1499, remaining: 1 }],
      error: null,
    });

    await expect(
      releaseMonthlyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        periodStart: '2026-08-01',
      })
    ).resolves.toEqual({
      released: true,
      used: 1499,
      remaining: 1,
      periodStart: '2026-08-01',
      limit: 1500,
    });
  });

  it('fails closed when the database does not return a quota row', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(
      reserveMonthlyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        periodStart: '2026-08-01',
      })
    ).rejects.toThrow('MONTHLY_QUOTA_RESULT_MISSING');
  });

  it('surfaces database reservation errors without allowing a request', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });
    await expect(
      reserveMonthlyQuota({
        supabaseAdmin: createClient(rpc),
        userId: USER_ID,
        requestId: REQUEST_ID,
        periodStart: '2026-08-01',
      })
    ).rejects.toThrow(
      'MONTHLY_QUOTA_RESERVE_FAILED: database unavailable'
    );
  });
});

function createClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient;
}
