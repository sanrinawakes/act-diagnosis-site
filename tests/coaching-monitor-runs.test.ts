import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildCoachingMonitorRunRecord,
  COACHING_MONITOR_ALERT_COOLDOWN_MS,
  COACHING_MONITOR_STALE_AFTER_MS,
  failStaleCoachingMonitorRuns,
  findRecentAcceptedMonitorFailureAlert,
  persistCoachingMonitorRun,
  recoverStaleCoachingMonitorRuns,
  updateCoachingMonitorAlertDelivery,
  type CoachingMonitorMetrics,
} from '@/lib/coaching-monitor-runs';

const metrics: CoachingMonitorMetrics = {
  status: 200,
  inputMessages: 24,
  storedMessagesBeforeReply: 81,
  storedMessagesAfterReply: 82,
  payloadBytes: 12345,
  signInMs: 100,
  profileMs: 200,
  sessionCreateMs: 50,
  userMessageSaveMs: 70,
  historyLoadMs: 80,
  firstChunkMs: 1200,
  doneMs: 1700,
  chatTotalMs: 1800,
  journeyTotalMs: 2600,
  assistantSaveMs: 90,
  reloadMs: 100,
  memoryRefreshMs: 400,
  memoryRefreshVerified: true,
  outputChars: 63,
  returnedFallback: false,
  provider: 'gemini',
  fallbackFrom: null,
  completionStatus: 'complete',
  finalizationStatus: 'complete',
  hasDone: true,
  remaining: 49,
  cookieAuthUsed: true,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildCoachingMonitorRunRecord', () => {
  it('stores only operational metrics for a successful run', () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc123');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_123');
    vi.stubEnv('VERCEL_URL', 'deployment.example.com');

    const record = buildCoachingMonitorRunRecord({
      id: '580e9d31-8462-4e68-a144-c1d75e1df297',
      status: 'success',
      baseUrl: 'https://act-diagnosis-site.vercel.app',
      checkedAt: '2026-07-21T08:00:00.000Z',
      elapsedMs: 2700,
      result: metrics,
    });

    expect(record).toMatchObject({
      status: 'success',
      deployment_commit: 'abc123',
      deployment_id: 'dpl_123',
      deployment_url: 'deployment.example.com',
      first_chunk_ms: 1200,
      stored_messages_after_reply: 82,
      completion_status: 'complete',
      has_done: true,
      remaining: 49,
      cookie_auth_used: true,
      error: null,
    });
    expect(record.stage_timings).toEqual({
      signInMs: 100,
      profileMs: 200,
      sessionCreateMs: 50,
      userMessageSaveMs: 70,
      historyLoadMs: 80,
      doneMs: 1700,
      assistantSaveMs: 90,
      reloadMs: 100,
      memoryRefreshMs: 400,
      memoryRefreshVerified: 1,
    });
    expect(JSON.stringify(record)).not.toContain('相談本文');
  });

  it('retains measured values and the reason when a health assertion fails', () => {
    const record = buildCoachingMonitorRunRecord({
      id: '580e9d31-8462-4e68-a144-c1d75e1df297',
      status: 'failure',
      baseUrl: 'https://act-diagnosis-site.vercel.app',
      checkedAt: '2026-07-21T08:00:00.000Z',
      elapsedMs: 17000,
      result: { ...metrics, firstChunkMs: 16521 },
      error: 'monitor first chunk too slow: 16521ms',
    });

    expect(record.status).toBe('failure');
    expect(record.first_chunk_ms).toBe(16521);
    expect(record.error).toBe('monitor first chunk too slow: 16521ms');
  });

  it('creates a content-free running record before the monitor starts', () => {
    const record = buildCoachingMonitorRunRecord({
      id: '580e9d31-8462-4e68-a144-c1d75e1df297',
      status: 'running',
      baseUrl: 'https://act-diagnosis-site.vercel.app',
      checkedAt: '2026-07-21T08:00:00.000Z',
      elapsedMs: 0,
      result: null,
    });

    expect(record).toMatchObject({
      status: 'running',
      first_chunk_ms: null,
      has_done: null,
      error: null,
      stage_timings: {},
    });
  });
});

describe('monitor run persistence', () => {
  it('inserts a monitor row and returns its id', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ error: null });
    const upsert = vi.fn(() => ({ abortSignal }));
    const from = vi.fn(() => ({ upsert }));

    const id = await persistCoachingMonitorRun(
      { from } as unknown as SupabaseClient,
      buildCoachingMonitorRunRecord({
        id: '580e9d31-8462-4e68-a144-c1d75e1df297',
        status: 'success',
        baseUrl: 'https://act-diagnosis-site.vercel.app',
        checkedAt: '2026-07-21T08:00:00.000Z',
        elapsedMs: 2700,
        result: metrics,
      })
    );

    expect(id).toBe('580e9d31-8462-4e68-a144-c1d75e1df297');
    expect(from).toHaveBeenCalledWith('coaching_monitor_runs');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.any(Object), {
      onConflict: 'id',
    });
    expect(abortSignal).toHaveBeenCalledTimes(1);
  });

  it('throws when the monitor row cannot be persisted', async () => {
    const from = vi.fn(() => ({
      upsert: () => ({
        abortSignal: () =>
          Promise.resolve({
            error: { message: 'relation does not exist' },
          }),
      }),
    }));

    await expect(
      persistCoachingMonitorRun(
        { from } as unknown as SupabaseClient,
        buildCoachingMonitorRunRecord({
          id: '580e9d31-8462-4e68-a144-c1d75e1df297',
          status: 'failure',
          baseUrl: 'https://act-diagnosis-site.vercel.app',
          checkedAt: '2026-07-21T08:00:00.000Z',
          elapsedMs: 10,
          result: null,
          error: 'monitor failed',
        })
      )
    ).rejects.toThrow('coaching monitor result persistence failed');
  });

  it('wraps a monitor persistence timeout with an actionable error', async () => {
    const abortSignal = vi
      .fn()
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockResolvedValueOnce({ error: null });
    const from = vi.fn(() => ({
      upsert: () => ({
        abortSignal,
      }),
    }));

    const id = await persistCoachingMonitorRun(
      { from } as unknown as SupabaseClient,
      buildCoachingMonitorRunRecord({
        id: '580e9d31-8462-4e68-a144-c1d75e1df297',
        status: 'failure',
        baseUrl: 'https://act-diagnosis-site.vercel.app',
        checkedAt: '2026-07-21T08:00:00.000Z',
        elapsedMs: 5000,
        result: null,
        error: 'monitor failed',
      })
    );

    expect(id).toBe('580e9d31-8462-4e68-a144-c1d75e1df297');
    expect(abortSignal).toHaveBeenCalledTimes(2);
  });

  it('throws after retryable persistence failures continue', async () => {
    const abortSignal = vi
      .fn()
      .mockRejectedValue(new Error('request timed out'));
    const from = vi.fn(() => ({
      upsert: () => ({
        abortSignal,
      }),
    }));

    await expect(
      persistCoachingMonitorRun(
        { from } as unknown as SupabaseClient,
        buildCoachingMonitorRunRecord({
          id: '580e9d31-8462-4e68-a144-c1d75e1df297',
          status: 'failure',
          baseUrl: 'https://act-diagnosis-site.vercel.app',
          checkedAt: '2026-07-21T08:00:00.000Z',
          elapsedMs: 5000,
          result: null,
          error: 'monitor failed',
        })
      )
    ).rejects.toThrow(
      'coaching monitor result persistence failed: request timed out'
    );
    expect(abortSignal).toHaveBeenCalledTimes(2);
  });

  it('records alert delivery on a failed monitor row', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ error: null });
    const inFilter = vi.fn(() => ({ abortSignal }));
    const update = vi.fn(() => ({ in: inFilter }));
    const from = vi.fn(() => ({ update }));

    await updateCoachingMonitorAlertDelivery(
      { from } as unknown as SupabaseClient,
      ['580e9d31-8462-4e68-a144-c1d75e1df297'],
      { accepted: true, status: 200, id: 'resend_123' }
    );

    expect(update).toHaveBeenCalledWith({
      alert_accepted: true,
      alert_status: 200,
      alert_resend_id: 'resend_123',
      alert_reason: null,
    });
    expect(inFilter).toHaveBeenCalledWith(
      'id',
      ['580e9d31-8462-4e68-a144-c1d75e1df297']
    );
  });

  it('finds an accepted identical failure alert from the last hour', async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      gte: vi.fn(),
      lt: vi.fn(),
      neq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      abortSignal: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'previous-monitor-run-id',
          checked_at: '2026-07-25T09:01:12.003Z',
          alert_resend_id: 'previous-resend-id',
        },
        error: null,
      }),
    };
    Object.values(query)
      .filter((mock) => mock !== query.maybeSingle)
      .forEach((mock) => mock.mockReturnValue(query));
    const from = vi.fn(() => query);

    const result = await findRecentAcceptedMonitorFailureAlert(
      { from } as unknown as SupabaseClient,
      {
        error: 'paid monitor persistence mismatch: expected 82 rows, received 83',
        checkedAt: '2026-07-25T10:01:09.060Z',
        excludeRunId: 'current-monitor-run-id',
        deploymentCommit: 'current-deployment-sha',
      }
    );

    expect(result).toEqual({
      id: 'previous-monitor-run-id',
      checkedAt: '2026-07-25T09:01:12.003Z',
      resendId: 'previous-resend-id',
    });
    expect(query.eq.mock.calls).toEqual(
      expect.arrayContaining([
        ['monitor_path', 'paid-cookie-auth-and-persistence'],
        ['status', 'failure'],
        [
          'error',
          'paid monitor persistence mismatch: expected 82 rows, received 83',
        ],
        ['alert_accepted', true],
        ['deployment_commit', 'current-deployment-sha'],
      ])
    );
    expect(query.gte).toHaveBeenCalledWith(
      'checked_at',
      new Date(
        new Date('2026-07-25T10:01:09.060Z').getTime() -
          COACHING_MONITOR_ALERT_COOLDOWN_MS
      ).toISOString()
    );
    expect(query.lt).toHaveBeenCalledWith(
      'checked_at',
      '2026-07-25T10:01:09.060Z'
    );
    expect(query.neq).toHaveBeenCalledWith(
      'id',
      'current-monitor-run-id'
    );
  });

  it('turns stale running rows into failures for the next run to report', async () => {
    const abortSignal = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'bd945da2-a8ee-48da-8786-c95a1635b168',
          checked_at: '2026-07-21T07:57:00.000Z',
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ abortSignal }));
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));

    const rows = await failStaleCoachingMonitorRuns(
      { from } as unknown as SupabaseClient,
      new Date('2026-07-21T08:00:00.000Z')
    );

    expect(rows).toEqual([
      {
        id: 'bd945da2-a8ee-48da-8786-c95a1635b168',
        checked_at: '2026-07-21T07:57:00.000Z',
      },
    ]);
    expect(update).toHaveBeenCalledWith({
      status: 'failure',
      elapsed_ms: COACHING_MONITOR_STALE_AFTER_MS,
      error: 'monitor invocation did not finalize before the next check',
    });
    expect(eq).toHaveBeenCalledWith('status', 'running');
    expect(lt).toHaveBeenCalledWith(
      'checked_at',
      '2026-07-21T07:58:00.000Z'
    );
  });

  it('retries a stale-run timeout without failing the monitor cycle', async () => {
    const abortSignal = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('TimeoutError: The operation was aborted due to timeout')
      )
      .mockResolvedValueOnce({
        data: [
          {
            id: 'bd945da2-a8ee-48da-8786-c95a1635b168',
            checked_at: '2026-07-21T07:57:00.000Z',
          },
        ],
        error: null,
      });
    const select = vi.fn(() => ({ abortSignal }));
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));

    const result = await recoverStaleCoachingMonitorRuns(
      { from } as unknown as SupabaseClient,
      {
        now: new Date('2026-07-21T08:00:00.000Z'),
        maxAttempts: 2,
        retryDelayMs: 0,
      }
    );

    expect(result).toEqual({
      runs: [
        {
          id: 'bd945da2-a8ee-48da-8786-c95a1635b168',
          checked_at: '2026-07-21T07:57:00.000Z',
        },
      ],
      attempts: 2,
      error: null,
    });
    expect(abortSignal).toHaveBeenCalledTimes(2);
  });

  it('reports repeated stale-run timeouts as maintenance without throwing', async () => {
    const abortSignal = vi
      .fn()
      .mockRejectedValue(
        new Error('TimeoutError: The operation was aborted due to timeout')
      );
    const select = vi.fn(() => ({ abortSignal }));
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));

    await expect(
      recoverStaleCoachingMonitorRuns(
        { from } as unknown as SupabaseClient,
        {
          now: new Date('2026-07-21T08:00:00.000Z'),
          maxAttempts: 2,
          retryDelayMs: 0,
        }
      )
    ).resolves.toEqual({
      runs: [],
      attempts: 2,
      error:
        'stale coaching monitor recovery failed: TimeoutError: The operation was aborted due to timeout',
    });
    expect(abortSignal).toHaveBeenCalledTimes(2);
  });
});
