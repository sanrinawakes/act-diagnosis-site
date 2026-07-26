import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
    const recentFailure = {
      id: '8e7f6bb8-e1e7-482e-9747-281b2d93011a',
      status: 'failure',
      checked_at: '2026-07-25T21:50:30.232Z',
      http_status: 200,
      first_chunk_ms: 11219,
      chat_total_ms: 11875,
      completion_status: 'complete',
      finalization_status: 'complete',
      error: 'monitor first chunk too slow: 11219ms',
    };

    mocks.createClient.mockReturnValue(
      createQueueClient(latestMonitors, [recentFailure])
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
    expect(body.latest_coaching_monitors).not.toContainEqual(recentFailure);
    expect(body.recent_coaching_failures).toEqual([recentFailure]);
  });
});

function createQueueClient(
  latestMonitors: Array<Record<string, unknown>>,
  monitorFailures: Array<Record<string, unknown>>
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
                          limit: async () => ({ data: [], error: null }),
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
                  limit: async () => ({
                    data: latestMonitors,
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
                          limit: async () => ({
                            data: monitorFailures,
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

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}
