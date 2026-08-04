import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  appendSupportReplyLog,
  buildSupportAutomationNoteEntry,
} from '../src/lib/support-reply-log';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));
vi.mock('server-only', () => ({}));

let GET: typeof import('../src/app/api/internal/support-automation/route').GET;

describe('GET /api/internal/support-automation monitor feed', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('SUPPORT_AUTOMATION_SECRET', 'automation-test-secret');
    ({ GET } = await import(
      '../src/app/api/internal/support-automation/route'
    ));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns recent failures separately so hourly automation cannot miss them', async () => {
    const latestMonitors = Array.from({ length: 6 }, (_, index) => ({
      id: `success-${index}`,
      status: 'success',
      checked_at: `2026-07-26T00:${30 - index * 10}:00.000Z`,
      error: null,
    }));
    const recentFailures = Array.from({ length: 25 }, (_, index) => ({
      id:
        index === 0
          ? '8e7f6bb8-e1e7-482e-9747-281b2d93011a'
          : `failure-${index}`,
      status: 'failure',
      checked_at: `2026-07-25T${String(21 - Math.floor(index / 6)).padStart(
        2,
        '0'
      )}:${String(50 - (index % 6) * 10).padStart(2, '0')}:30.232Z`,
      http_status: 200,
      first_chunk_ms: 11219,
      chat_total_ms: 11875,
      completion_status: 'complete',
      finalization_status: 'complete',
      error: 'monitor first chunk too slow: 11219ms',
    }));

    mocks.createClient.mockReturnValue(
      createQueueClient(latestMonitors, recentFailures)
    );

    const response = await GET(
      new NextRequest(
        'https://act-diagnosis-site.vercel.app/api/internal/support-automation',
        {
          headers: {
            Authorization: 'Bearer automation-test-secret',
          },
        }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.queue_count).toBe(0);
    expect(body.latest_coaching_monitors).toHaveLength(6);
    expect(body.latest_coaching_monitors).not.toContainEqual(recentFailures[0]);
    expect(body.recent_coaching_failures).toEqual(recentFailures);
  });

  it('returns decision holds separately so Codex can surface them in-app', async () => {
    const pendingTicketId = 'c37c48af-6c63-4698-98e2-b0f509451a96';
    const decisionRequest = buildSupportAutomationNoteEntry({
      recordedAt: '2026-07-26T02:00:00.000Z',
      automationRunId: 'automation_decision_001',
      idempotencyKey: `decision-${pendingTicketId}`,
      status: 'decision_required',
      note: [
        '確認済み事実: 1か月1500回の上限に達しています。',
        '判断事項: 利用上限を変更するか決めてください。',
        '推奨案: 現行上限を維持する。',
      ].join('\n'),
    });
    const supportTickets = [
      {
        id: pendingTicketId,
        user_id: null,
        name: '判断待ち顧客',
        email: 'decision@example.com',
        category: 'general',
        subject: '利用上限について',
        message: appendSupportReplyLog('上限を増やしてください。', decisionRequest),
        status: 'in_progress',
        created_at: '2026-07-26T01:50:00.000Z',
        updated_at: '2026-07-26T02:00:00.000Z',
      },
      {
        id: 'a7f35f77-04ce-41ff-9aac-b913044d5e88',
        user_id: null,
        name: '技術対応顧客',
        email: 'technical@example.com',
        category: 'bug',
        subject: '画面エラー',
        message: '送信ボタンを押すとエラーになります。',
        status: 'open',
        created_at: '2026-07-26T02:01:00.000Z',
        updated_at: '2026-07-26T02:01:00.000Z',
      },
    ];

    mocks.createClient.mockReturnValue(
      createQueueClient([], [], supportTickets)
    );

    const response = await GET(
      new NextRequest(
        'https://act-diagnosis-site.vercel.app/api/internal/support-automation',
        {
          headers: {
            Authorization: 'Bearer automation-test-secret',
          },
        }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.queue_count).toBe(1);
    expect(body.tickets[0]).toMatchObject({
      id: supportTickets[1].id,
      decision: { pending: false },
    });
    expect(body.pending_decision_count).toBe(1);
    expect(body.pending_decisions[0]).toMatchObject({
      id: pendingTicketId,
      name: '判断待ち顧客',
      email: 'decision@example.com',
      decision: {
        requested: true,
        provided: false,
        pending: true,
      },
    });
    expect(body.tickets).not.toContainEqual(
      expect.objectContaining({ id: pendingTicketId })
    );
  });
});

function createQueueClient(
  latestMonitors: Array<Record<string, unknown>>,
  monitorFailures: Array<Record<string, unknown>>,
  supportTickets: Array<Record<string, unknown>> = []
) {
  return {
    from(table: string) {
      if (table === 'support_tickets') {
        return {
          select() {
            return {
              in() {
                return {
                  gte() {
                    return {
                      order() {
                        return {
                          limit: async () => ({
                            data: supportTickets,
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
      }

      if (table === 'coaching_monitor_runs') {
        return {
          select() {
            return {
              order() {
                return {
                  limit: async (limit: number) => ({
                    data: latestMonitors.slice(0, limit),
                    error: null,
                  }),
                };
              },
              eq() {
                return {
                  gte() {
                    return {
                      order() {
                        return {
                          limit: async (limit: number) => ({
                            data: monitorFailures.slice(0, limit),
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
      }

      if (table === 'profiles') {
        const emptyProfileResult = async () => ({
          data: [],
          error: null,
        });
        return {
          select() {
            return {
              limit() {
                return {
                  eq: emptyProfileResult,
                  ilike: emptyProfileResult,
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}
