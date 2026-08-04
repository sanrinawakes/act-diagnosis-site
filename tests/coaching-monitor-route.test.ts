import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createSupabaseClient: vi.fn(),
  createSsrClient: vi.fn(),
  persistMonitorRun: vi.fn(),
  recoverStaleRuns: vi.fn(),
  findRecentAcceptedFailureAlert: vi.fn(),
  updateAlertDelivery: vi.fn(),
  sendAlert: vi.fn(),
  assertHealthy: vi.fn(),
  auditStoredQuality: vi.fn(),
  reloadRoleFilter: vi.fn(),
  insertChatMessages: vi.fn(),
  deleteMonthlyUsage: vi.fn(),
  updateMonthlyProfile: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createSupabaseClient,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mocks.createSsrClient,
}));

vi.mock('../src/lib/coaching-monitor-runs', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/lib/coaching-monitor-runs')>();
  return {
    ...actual,
    persistCoachingMonitorRun: mocks.persistMonitorRun,
    recoverStaleCoachingMonitorRuns: mocks.recoverStaleRuns,
    findRecentAcceptedMonitorFailureAlert:
      mocks.findRecentAcceptedFailureAlert,
    updateCoachingMonitorAlertDelivery: mocks.updateAlertDelivery,
  };
});

vi.mock('../src/lib/coaching-alerts', () => ({
  sendCoachingAlert: mocks.sendAlert,
}));

vi.mock('../src/lib/coaching-monitor-health', () => ({
  assertHealthyCoachingMonitorResult: mocks.assertHealthy,
}));

vi.mock('../src/lib/coaching-quality-incidents', () => ({
  auditRecentStoredCoachingResponses: mocks.auditStoredQuality,
}));

let GET: typeof import('../src/app/api/monitor/coaching/route').GET;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ANSWER = '明日の朝、最初に取り組むことを一つメモしてください。';

describe('GET /api/monitor/coaching maintenance isolation', () => {
  beforeAll(async () => {
    vi.stubEnv('COACHING_MONITOR_EMAIL', 'monitor@example.com');
    vi.stubEnv('COACHING_MONITOR_PASSWORD', 'monitor-password');
    ({ GET } = await import('../src/app/api/monitor/coaching/route'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CRON_SECRET', 'monitor-test-secret');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'current-deployment-sha');

    const adminClient = createAdminClient();
    const userClient = createUserClient();
    mocks.createSupabaseClient.mockImplementation(
      (_url: string, _key: string, options?: Record<string, unknown>) =>
        options && 'global' in options ? userClient : adminClient
    );
    mocks.createSsrClient.mockImplementation(
      (
        _url: string,
        _key: string,
        options: {
          cookies: {
            setAll: (
              cookies: Array<{
                name: string;
                value: string;
                options?: Record<string, unknown>;
              }>
            ) => void;
          };
        }
      ) => {
        options.cookies.setAll([
          { name: 'sb-monitor-auth', value: 'authenticated-cookie' },
        ]);
        return {
          auth: {
            signInWithPassword: vi.fn().mockResolvedValue({
              data: {
                user: { id: USER_ID },
                session: { access_token: 'monitor-access-token' },
              },
              error: null,
            }),
          },
        };
      }
    );
    mocks.persistMonitorRun.mockResolvedValue('monitor-run-id');
    mocks.findRecentAcceptedFailureAlert.mockResolvedValue(null);
    mocks.recoverStaleRuns.mockResolvedValue({
      runs: [],
      attempts: 2,
      error:
        'stale coaching monitor recovery failed: TimeoutError: The operation was aborted due to timeout',
    });
    mocks.sendAlert.mockResolvedValue({
      accepted: true,
      status: 200,
      id: 'resend-maintenance-alert',
    });
    mocks.updateAlertDelivery.mockResolvedValue(undefined);
    mocks.assertHealthy.mockReturnValue(undefined);
    mocks.auditStoredQuality.mockResolvedValue({
      scannedResponses: 3,
      scannedSessions: 2,
      detectedIncidents: 1,
      persistedIncidents: 1,
      elapsedMs: 12,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          [
            JSON.stringify({ type: 'chunk', text: ANSWER }),
            JSON.stringify({
              type: 'done',
              message: ANSWER,
              provider: 'gemini',
              completionStatus: 'complete',
              finalizationStatus: 'complete',
              remaining: 49,
            }),
            '',
          ].join('\n'),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
            },
          }
        )
      )
    );
  });

  it('returns a successful user journey when stale-run maintenance times out', async () => {
    const response = await GET(createMonitorRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      result: {
        status: 200,
        storedMessagesBeforeReply: 81,
        storedMessagesAfterReply: 82,
        hasDone: true,
        completionStatus: 'complete',
        finalizationStatus: 'complete',
        memoryRefreshVerified: true,
        cookieAuthUsed: true,
      },
      maintenance: {
        staleRecoveryAttempts: 2,
        staleRecoveryStatus: 'failed',
      },
      qualityAudit: {
        scannedResponses: 3,
        scannedSessions: 2,
        detectedIncidents: 1,
        persistedIncidents: 1,
        elapsedMs: 12,
      },
    });
    expect(mocks.persistMonitorRun).toHaveBeenCalledTimes(2);
    expect(mocks.persistMonitorRun.mock.calls[0][1]).toMatchObject({
      status: 'running',
    });
    expect(mocks.persistMonitorRun.mock.calls[1][1]).toMatchObject({
      status: 'success',
      http_status: 200,
      has_done: true,
      stage_timings: expect.objectContaining({
        qualityAuditMs: 12,
        qualityIncidentsDetected: 1,
      }),
    });
    expect(mocks.auditStoredQuality).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: '[ACTI Bot] 定期監視の記録整理で異常を検知しました',
        summary: expect.stringContaining(
          '利用者の会話エラーを検知した通知ではありません'
        ),
      })
    );
    expect(mocks.updateAlertDelivery).toHaveBeenCalledWith(
      expect.anything(),
      [expect.any(String)],
      expect.objectContaining({ accepted: true })
    );
    expect(mocks.reloadRoleFilter).toHaveBeenCalledWith('role', [
      'user',
      'assistant',
    ]);
    expect(mocks.deleteMonthlyUsage).toHaveBeenCalledWith({
      user_id: USER_ID,
      period_start: expect.stringMatching(/^\d{4}-\d{2}-01$/),
    });
    expect(mocks.updateMonthlyProfile).toHaveBeenCalledWith({
      chat_count_month: 0,
      chat_month_start: expect.stringMatching(/^\d{4}-\d{2}-01$/),
    });
    const insertedRows = mocks.insertChatMessages.mock.calls.at(-1)?.[0];
    expect(Array.isArray(insertedRows)).toBe(true);
    expect(insertedRows?.at(-1)?.content).toBe(
      '定期監視です。今も前の相談内容を踏まえているか、短く自然に教えてください。'
    );
  });

  it('suppresses a transient maintenance timeout after the retry succeeds', async () => {
    mocks.recoverStaleRuns.mockResolvedValue({
      runs: [],
      attempts: 2,
      error: null,
    });

    const response = await GET(createMonitorRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.maintenance).toEqual({
      staleRecoveryAttempts: 2,
      staleRecoveryStatus: 'complete',
      staleRecoveryError: null,
    });
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it('still returns and alerts on a real user-journey failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('provider unavailable', { status: 503 })
      )
    );

    const response = await GET(createMonitorRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      error: expect.stringContaining('paid coaching monitor failed 503'),
      alertAccepted: true,
    });
    expect(mocks.recoverStaleRuns).not.toHaveBeenCalled();
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: '[ACTI Bot] 定期監視で異常を検知しました',
        summary: expect.stringContaining(
          'ログインCookie・履歴保存・AI送信・返信保存'
        ),
      })
    );
    expect(mocks.persistMonitorRun.mock.calls[1][1]).toMatchObject({
      status: 'failure',
      error: expect.stringContaining('paid coaching monitor failed 503'),
    });
  });

  it('accepts the support automation secret alongside the Vercel cron secret', async () => {
    vi.stubEnv('SUPPORT_AUTOMATION_SECRET', 'support-automation-test-secret');

    const response = await GET(
      createMonitorRequest('support-automation-test-secret')
    );

    expect(response.status).toBe(200);
  });

  it('suppresses the same accepted failure alert for one deployment during the cooldown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('provider unavailable', { status: 503 })
      )
    );
    mocks.findRecentAcceptedFailureAlert.mockResolvedValue({
      id: 'previous-monitor-run-id',
      checkedAt: '2026-07-25T09:01:12.003Z',
      resendId: 'previous-resend-id',
    });

    const response = await GET(createMonitorRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      alertAccepted: false,
      alertSuppressed: true,
      previousAlertMonitorRunId: 'previous-monitor-run-id',
    });
    expect(mocks.findRecentAcceptedFailureAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        error: expect.stringContaining('paid coaching monitor failed 503'),
        deploymentCommit: 'current-deployment-sha',
      })
    );
    expect(mocks.sendAlert).not.toHaveBeenCalled();
    expect(mocks.updateAlertDelivery).toHaveBeenCalledWith(
      expect.anything(),
      [expect.any(String)],
      expect.objectContaining({
        accepted: false,
        reason: expect.stringContaining('previous-monitor-run-id'),
      })
    );
  });

  it('still sends the failure alert when duplicate detection is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('provider unavailable', { status: 503 })
      )
    );
    mocks.findRecentAcceptedFailureAlert.mockRejectedValue(
      new Error('monitor database temporarily unavailable')
    );

    const response = await GET(createMonitorRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      alertAccepted: true,
      alertSuppressed: false,
      previousAlertMonitorRunId: null,
    });
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });
});

function createMonitorRequest(secret = 'monitor-test-secret') {
  return new NextRequest(
    'https://act-diagnosis-site.vercel.app/api/monitor/coaching',
    {
      headers: { Authorization: `Bearer ${secret}` },
    }
  );
}

function createAdminClient() {
  return {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select() {
            return {
              eq() {
                return {
                  single: async () => ({
                    data: {
                      role: 'member',
                      subscription_status: 'active',
                      is_active: true,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            mocks.updateMonthlyProfile(values);
            return {
              eq: async () => ({ error: null }),
            };
          },
        };
      }
      if (table === 'coaching_monthly_usage') {
        return {
          delete() {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return {
                  eq: async (nextColumn: string, nextValue: unknown) => {
                    filters[nextColumn] = nextValue;
                    mocks.deleteMonthlyUsage(filters);
                    return { error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'chat_sessions') {
        return {
          delete() {
            return {
              eq: async () => ({ error: null }),
            };
          },
        };
      }
      if (table === 'chat_messages') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      like() {
                        return {
                          order() {
                            return {
                              limit() {
                                return {
                                  maybeSingle: async () => ({
                                    data: {
                                      content:
                                        'ACTI_SESSION_MEMORY_V1\n{"coveredMessageCount":57}',
                                    },
                                    error: null,
                                  }),
                                };
                              },
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected admin table: ${table}`);
    },
  };
}

function createUserClient() {
  return {
    from(table: string) {
      if (table === 'site_settings') {
        return {
          select() {
            return {
              single: async () => ({
                data: { bot_enabled: true },
                error: null,
              }),
            };
          },
        };
      }
      if (table === 'chat_sessions') {
        return {
          insert() {
            return {
              select() {
                return {
                  single: async () => ({
                    data: { id: SESSION_ID },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === 'chat_messages') {
        return createChatMessagesQuery();
      }
      throw new Error(`Unexpected user table: ${table}`);
    },
  };
}

function createChatMessagesQuery() {
  return {
    insert: async (rows: unknown) => {
      mocks.insertChatMessages(rows);
      return { error: null };
    },
    select(columns: string) {
      if (columns === 'role, content, created_at') {
        return {
          eq() {
            return {
              in() {
                return {
                  order() {
                    return {
                      limit: async () => ({
                        data: Array.from({ length: 24 }, (_, index) => ({
                          role: index % 2 === 0 ? 'user' : 'assistant',
                          content: `監視履歴 ${index}`,
                          created_at: new Date(index * 1000).toISOString(),
                        })),
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (columns === 'id, role, content') {
        return {
          eq() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      id: 'assistant-message-id',
                      role: 'assistant',
                      content: ANSWER,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (columns === 'role, content') {
        return {
          eq() {
            return {
              in(column: string, values: string[]) {
                mocks.reloadRoleFilter(column, values);
                return {
                  order() {
                    return {
                      limit: async () => ({
                        data: [
                          { role: 'assistant', content: ANSWER },
                          { role: 'user', content: '定期監視です。' },
                        ],
                        count: 82,
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected chat_messages select: ${columns}`);
    },
  };
}
