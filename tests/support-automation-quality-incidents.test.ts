import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));
vi.mock('server-only', () => ({}));

let POST: typeof import('../src/app/api/internal/support-automation/route').POST;

const INCIDENT_ID = 'c1e5a62e-7140-4a1c-99c0-15508806ef7b';
const RUN_ID = 'quality_run_20260804';

describe('POST /api/internal/support-automation quality incidents', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('SUPPORT_AUTOMATION_SECRET', 'automation-test-secret');
    ({ POST } = await import(
      '../src/app/api/internal/support-automation/route'
    ));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('claims an open semantic quality incident atomically', async () => {
    const client = createIncidentClient({
      status: 'open',
      claimed_run_id: null,
      claimed_at: null,
    });
    mocks.createClient.mockReturnValue(client);

    const response = await POST(
      qualityRequest({
        action: 'quality_claim',
        quality_incident_id: INCIDENT_ID,
        run_id: RUN_ID,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      claimed: true,
      run_id: RUN_ID,
      quality_incident: {
        status: 'in_progress',
        claimed_run_id: RUN_ID,
      },
    });
    expect(client.updates[0]).toMatchObject({
      status: 'in_progress',
      claimed_run_id: RUN_ID,
    });
  });

  it('records a verified no-code resolution without sending customer mail', async () => {
    const client = createIncidentClient({
      status: 'in_progress',
      claimed_run_id: RUN_ID,
      claimed_at: '2026-08-04T09:00:00.000Z',
    });
    mocks.createClient.mockReturnValue(client);

    const response = await POST(
      qualityRequest({
        action: 'quality_resolve',
        quality_incident_id: INCIDENT_ID,
        run_id: RUN_ID,
        resolution_kind: 'no_code_change',
        resolution_note:
          '保存済み回答と前後の履歴を確認し、既に本番反映済みの遮断規則で再現しないことを確認した。',
        evidence: { checked_at: '2026-08-04T10:00:00.000Z' },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.quality_incident).toMatchObject({
      status: 'resolved',
      resolution_kind: 'no_code_change',
    });
    expect(client.updates[0]).toMatchObject({
      status: 'resolved',
      resolution_kind: 'no_code_change',
      resolution_note: expect.stringContaining('保存済み回答'),
    });
  });

  it('rejects a run that does not own the incident', async () => {
    mocks.createClient.mockReturnValue(
      createIncidentClient({
        status: 'in_progress',
        claimed_run_id: 'different_run',
        claimed_at: '2026-08-04T09:00:00.000Z',
      })
    );

    const response = await POST(
      qualityRequest({
        action: 'quality_release',
        quality_incident_id: INCIDENT_ID,
        run_id: RUN_ID,
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Quality incident is owned by another automation run',
    });
  });

  it('resolves a technical fix when GitHub check-runs times out but checks HTML proves success', async () => {
    const client = createIncidentClient({
      status: 'in_progress',
      claimed_run_id: RUN_ID,
      claimed_at: '2026-08-17T23:40:31.719Z',
      updated_at: '2026-08-17T23:40:31.719Z',
    });
    mocks.createClient.mockReturnValue(client);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha: 'a78e38c74411d0481783d525047cafb46419fd3b' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce(
        new Response(
          '<html><span data-favicon-override="https://github.githubassets.com/favicons/favicon-success.svg"></span><a href="/actions/runs/1/job/2"><span>unit-and-build</span></a><check-steps data-job-status="completed"><check-step data-conclusion="success"></check-step></check-steps></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      qualityRequest({
        action: 'quality_resolve',
        quality_incident_id: INCIDENT_ID,
        run_id: RUN_ID,
        resolution_kind: 'technical_fix',
        resolution_note:
          '価格の言い換え相談で汎用文へ逃げていたため、具体的な言い換え文を返す分岐へ修正した。',
        evidence: {
          productionCommit: 'a78e38c74411d0481783d525047cafb46419fd3b',
          productionDeploymentId: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
          monitorSuccesses: 6,
          observationMinutes: 21.9,
          releaseGatePassed: true,
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.quality_incident).toMatchObject({
      status: 'resolved',
      resolution_kind: 'technical_fix',
    });
    expect(client.updates.at(-1)).toMatchObject({
      status: 'resolved',
      resolution_kind: 'technical_fix',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

function createIncidentClient(
  overrides: Partial<Record<string, unknown>> = {}
) {
  let incident = {
    id: INCIDENT_ID,
    assistant_message_id: 'f9344148-0b68-4f48-b613-21a63c840422',
    session_id: '2722bbd4-ccbf-4cd0-b2a9-d69c7f4048d3',
    user_id: '0e7bea61-5a41-4e19-a9de-66d7ed5fa400',
    issue: 'post_delivery_quality_failure',
    source: 'scheduled_audit',
    status: 'open',
    message_created_at: '2026-08-04T08:59:00.000Z',
    detected_at: '2026-08-04T09:00:00.000Z',
    deployment_commit: 'abc123',
    details: { qualityIssues: ['context_mismatch'] },
    claimed_run_id: null,
    claimed_at: null,
    updated_at: '2026-08-04T09:00:00.000Z',
    ...overrides,
  };
  const updates: Array<Record<string, unknown>> = [];

  return {
    updates,
    from(table: string) {
      if (table === 'coaching_quality_incidents') {
        return {
          select() {
            return {
              eq() {
                return {
                  single: async () => ({ data: incident, error: null }),
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            updates.push(values);
            const chain = {
              eq() {
                return chain;
              },
              select() {
                return {
                  maybeSingle: async () => {
                    incident = { ...incident, ...values };
                    return { data: incident, error: null };
                  },
                };
              },
            };
            return chain;
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
                    data: [
                      {
                        status: 'success',
                        checked_at: '2026-08-17T23:46:43.440Z',
                        deployment_commit: 'a78e38c74411d0481783d525047cafb46419fd3b',
                        deployment_id: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
                        http_status: 200,
                        completion_status: 'complete',
                        finalization_status: 'complete',
                        error: null,
                      },
                      {
                        status: 'success',
                        checked_at: '2026-08-17T23:34:43.440Z',
                        deployment_commit: 'a78e38c74411d0481783d525047cafb46419fd3b',
                        deployment_id: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
                        http_status: 200,
                        completion_status: 'complete',
                        finalization_status: 'complete',
                        error: null,
                      },
                      {
                        status: 'success',
                        checked_at: '2026-08-17T23:24:43.440Z',
                        deployment_commit: 'a78e38c74411d0481783d525047cafb46419fd3b',
                        deployment_id: 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX',
                        http_status: 200,
                        completion_status: 'complete',
                        finalization_status: 'complete',
                        error: null,
                      },
                    ],
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

function qualityRequest(body: Record<string, unknown>) {
  return new NextRequest(
    'https://act-diagnosis-site.vercel.app/api/internal/support-automation',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer automation-test-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}
