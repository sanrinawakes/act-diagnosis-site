import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  appendSupportReplyLog,
  buildSupportAutomationNoteEntry,
} from '../src/lib/support-reply-log';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  deliverSupportReply: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));
vi.mock('server-only', () => ({}));
vi.mock('../src/lib/server/support-email', () => ({
  deliverSupportReply: mocks.deliverSupportReply,
}));
vi.mock('../src/lib/server/support-decision-email', () => ({
  deliverSupportDecisionRequest: vi.fn(),
}));

let POST: typeof import('../src/app/api/internal/support-automation/route').POST;

describe('POST /api/internal/support-automation', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('SUPPORT_AUTOMATION_SECRET', 'automation-test-secret');
    ({ POST } = await import('../src/app/api/internal/support-automation/route'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns a verification error instead of 500 when GitHub commit lookup times out', async () => {
    const ticketId = '2db3af4c-7fe2-4c65-a761-fd2d4639eb36';
    const runId = 'run20260818a';
    const updatedAt = '2026-08-18T00:00:00.000Z';
    mocks.createClient.mockReturnValue(
      createReplyClient({
        ticket: {
          id: ticketId,
          user_id: '4fce0e73-2a43-4ee1-9d5b-b93cc8dfeb14',
          name: '技術対応顧客',
          email: 'member@example.com',
          category: 'bug',
          subject: '返信時に止まる',
          status: 'in_progress',
          created_at: '2026-08-17T23:40:00.000Z',
          updated_at: updatedAt,
          message: appendSupportReplyLog(
            '送信すると止まります。',
            buildSupportAutomationNoteEntry({
              recordedAt: updatedAt,
              automationRunId: runId,
              idempotencyKey: `claim-${runId}`,
              status: 'claimed',
              note: '自動調査を開始しました。',
            })
          ),
        },
        recentRuns: [
          {
            status: 'success',
            checked_at: '2026-08-18T00:30:00.000Z',
            deployment_commit: 'a78e38c74411d0481783d525047cafb46419fd3b',
            deployment_id: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
            http_status: 200,
            completion_status: 'complete',
            finalization_status: 'complete',
            error: null,
          },
          {
            status: 'success',
            checked_at: '2026-08-18T00:20:00.000Z',
            deployment_commit: 'a78e38c74411d0481783d525047cafb46419fd3b',
            deployment_id: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
            http_status: 200,
            completion_status: 'complete',
            finalization_status: 'complete',
            error: null,
          },
          {
            status: 'success',
            checked_at: '2026-08-18T00:05:00.000Z',
            deployment_commit: 'a78e38c74411d0481783d525047cafb46419fd3b',
            deployment_id: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
            http_status: 200,
            completion_status: 'complete',
            finalization_status: 'complete',
            error: null,
          },
        ],
      })
    );

    vi.mocked(fetch).mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    );

    const response = await POST(
      new NextRequest(
        'https://act-diagnosis-site.vercel.app/api/internal/support-automation',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer automation-test-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'reply',
            ticket_id: ticketId,
            run_id: runId,
            classification: 'technical',
            resolution_kind: 'technical_fix',
            subject: '対応状況のご連絡',
            message: '確認できた範囲をお知らせします。',
            idempotency_key: `reply-${ticketId}-20260818`,
            evidence: {
              productionCommit: 'a78e38c74411d0481783d525047cafb46419fd3b',
              productionDeploymentId: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
              monitorSuccesses: 3,
              observationMinutes: 25,
              releaseGatePassed: true,
            },
          }),
        }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: 'GitHub mainの本番コミットを確認できません',
    });
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
  });
});

function createReplyClient(params: {
  ticket: Record<string, unknown>;
  recentRuns: Array<Record<string, unknown>>;
}) {
  return {
    from(table: string) {
      if (table === 'support_tickets') {
        return {
          select() {
            return {
              eq(_column: string, value: string) {
                return {
                  single: async () => ({
                    data: value === params.ticket.id ? params.ticket : null,
                    error: value === params.ticket.id ? null : new Error('not found'),
                  }),
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
                    data: params.recentRuns,
                    error: null,
                  }),
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
