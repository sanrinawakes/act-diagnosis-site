import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  appendSupportReplyLog,
  buildSupportAutomationNoteEntry,
  buildSupportReplyLogEntry,
} from '@/lib/support-reply-log';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  deliverSupportReply: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/support-email', () => ({
  deliverSupportReply: mocks.deliverSupportReply,
}));
vi.mock('@/lib/server/support-decision-email', () => ({
  deliverSupportDecisionRequest: vi.fn(),
}));

let POST: typeof import('@/app/api/internal/support-automation/route').POST;

const TICKET_ID = '2db3af4c-7fe2-4c65-a761-fd2d4639eb36';
const RUN_ID = 'final_reply_gate_test';
const UPDATED_AT = '2026-10-16T22:00:00.000Z';
const COMMIT = 'a78e38c74411d0481783d525047cafb46419fd3b';
const DEPLOYMENT_ID = 'dpl_6jGkg4Xjz1ffgb3n6HBQpfSkoNYX';
const RELEASE_EVIDENCE = {
  productionCommit: COMMIT,
  productionDeploymentId: DEPLOYMENT_ID,
  monitorSuccesses: 3,
  observationMinutes: 20,
  releaseGatePassed: true,
};

describe('automated customer replies require a final resolution', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('SUPPORT_AUTOMATION_SECRET', 'automation-test-secret');
    ({ POST } = await import('@/app/api/internal/support-automation/route'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    mocks.deliverSupportReply.mockResolvedValue({ success: true });
  });

  it.each([
    ['technical', '現在も確認を進めております。', undefined],
    ['technical', 'ご不便をおかけしております。調査中です。', RELEASE_EVIDENCE],
    ['usage', 'お問い合わせありがとうございます。', undefined],
    ['account', '確認が取れ次第ご案内いたします。', { accountVerified: true }],
    ['product_feedback', 'ご意見を確認しております。', undefined],
    ['business_decision', '確認中です。', undefined],
    ['billing', '確認中です。', undefined],
    ['legal', '確認中です。', undefined],
  ])('blocks %s progress before any database or mail call', async (classification, message, evidence) => {
    const client = createClient();
    const response = await POST(replyRequest({
      classification,
      resolution_kind: 'progress',
      message,
      evidence,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '自動サポートから途中連絡は送信できません。対応完了後に最終回答をまとめて送信してください',
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['technical', 'usage_answer', undefined],
    ['technical', 'account_fix', { accountVerified: true }],
    ['account', 'usage_answer', undefined],
    ['account', 'technical_fix', RELEASE_EVIDENCE],
  ])('blocks a %s reply disguised as %s before any database or mail call', async (classification, resolution_kind, evidence) => {
    const client = createClient();
    const response = await POST(replyRequest({ classification, resolution_kind, evidence }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '問い合わせの分類に対応する解決種別と検証記録が必要です',
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a replay of an already sent progress message without changing its history', async () => {
    const client = createClient({
      message: appendSupportReplyLog(claimedTicket().message, buildSupportReplyLogEntry({
        sentAt: UPDATED_AT,
        senderEmail: 'ACTI自動サポート',
        toEmail: 'member@example.com',
        subject: 'お問い合わせへの回答',
        body: '現在も確認を進めております。',
        deliveryStatus: 'sent',
        idempotencyKey: `reply-${TICKET_ID}-final`,
      })),
    });
    const response = await POST(replyRequest({ resolution_kind: 'progress' }));

    expect(response.status).toBe(409);
    expect(client.from).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
  });

  it.each([
    ['usage', 'usage_answer', undefined],
    ['technical', 'technical_fix', RELEASE_EVIDENCE],
    ['technical', 'no_defect', { investigationVerified: true }],
    ['account', 'account_fix', { accountVerified: true }],
  ])('blocks an unfinished first-party status relabeled as %s / %s', async (classification, resolution_kind, evidence) => {
    const client = createClient();
    mockSuccessfulReleaseVerification();
    const response = await POST(replyRequest({
      classification,
      resolution_kind,
      evidence,
      message: '追加対策を本番へ反映し、現在も検証と監視を継続しています。',
    }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('途中連絡');
    expect(client.from).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['usage', 'usage_answer', undefined],
    ['account', 'account_fix', { accountVerified: true }],
    ['technical', 'technical_fix', RELEASE_EVIDENCE],
    ['technical', 'no_defect', { investigationVerified: true }],
    ['account', 'no_defect', { investigationVerified: true }],
  ])('preserves a verified %s final reply using %s', async (classification, resolution_kind, evidence) => {
    createClient();
    mockSuccessfulReleaseVerification();
    const response = await POST(replyRequest({ classification, resolution_kind, evidence }));

    expect(response.status).toBe(200);
    expect(mocks.deliverSupportReply).toHaveBeenCalledOnce();
    expect(mocks.deliverSupportReply).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: TICKET_ID,
      subject: 'お問い合わせへの回答',
      message: '確認した結果とご利用方法をご案内いたします。',
      statusOnSuccess: 'resolved',
      automationRunId: RUN_ID,
      expectedUpdatedAt: UPDATED_AT,
      idempotencyKey: `reply-${TICKET_ID}-final`,
    }));
  });

  it.each([
    undefined,
    { releaseGatePassed: false },
    { monitorSuccesses: 2 },
    { monitorSuccesses: 'not-a-number' },
    { observationMinutes: 'not-a-number' },
  ])('does not send when monitoring evidence is malformed: %j', async (invalidEvidence) => {
    const client = createClient();
    mockSuccessfulReleaseVerification();
    const response = await POST(replyRequest({
      resolution_kind: 'technical_fix',
      evidence: invalidEvidence === undefined ? undefined : { ...RELEASE_EVIDENCE, ...invalidEvidence },
    }));

    expect(response.status).toBe(409);
    expect(client.from).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['technical', 'account'])('requires verified investigation before a %s no-defect final reply', async (classification) => {
    const client = createClient();
    const response = await POST(replyRequest({ classification, resolution_kind: 'no_defect' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '障害ではないと判断した一次情報の確認記録が必要です',
    });
    expect(client.update).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
  });

  it('keeps authentication ahead of reply validation', async () => {
    const client = createClient();
    const response = await POST(replyRequest({ resolution_kind: 'progress' }, 'incorrect-secret'));

    expect(response.status).toBe(401);
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
  });

  it.each([
    { classification: 'unknown', resolution_kind: 'progress' },
    { classification: 'technical', resolution_kind: 'unknown' },
  ])('preserves invalid classification or resolution errors: %j', async (overrides) => {
    const client = createClient();
    const response = await POST(replyRequest(overrides));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid classification or resolution_kind' });
    expect(client.from).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
  });

  it.each([
    { run_id: 'another_automation_run' },
    { expected_updated_at: '2026-10-16T21:59:59.000Z' },
  ])('preserves ownership and revision checks for a permitted final reply: %j', async (overrides) => {
    const client = createClient();
    const response = await POST(replyRequest({
      classification: 'usage',
      resolution_kind: 'usage_answer',
      ...overrides,
    }));

    expect(response.status).toBe(409);
    expect(client.update).not.toHaveBeenCalled();
    expect(mocks.deliverSupportReply).not.toHaveBeenCalled();
  });
});

function replyRequest(overrides: Record<string, unknown>, secret = 'automation-test-secret') {
  return new NextRequest('https://example.com/api/internal/support-automation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'reply',
      ticket_id: TICKET_ID,
      run_id: RUN_ID,
      expected_updated_at: UPDATED_AT,
      classification: 'technical',
      resolution_kind: 'technical_fix',
      subject: 'お問い合わせへの回答',
      message: '確認した結果とご利用方法をご案内いたします。',
      idempotency_key: `reply-${TICKET_ID}-final`,
      ...overrides,
    }),
  });
}

function claimedTicket() {
  return {
    id: TICKET_ID,
    user_id: '4fce0e73-2a43-4ee1-9d5b-b93cc8dfeb14',
    name: 'テスト利用者',
    email: 'member@example.com',
    category: 'general',
    subject: '選択できない項目があります',
    message: appendSupportReplyLog('選択できない項目があります。', buildSupportAutomationNoteEntry({
      recordedAt: UPDATED_AT,
      automationRunId: RUN_ID,
      idempotencyKey: `claim-${RUN_ID}`,
      status: 'claimed',
      note: '調査の担当を記録しました。',
    })),
    status: 'in_progress',
    created_at: '2026-10-16T21:35:26.000Z',
    updated_at: UPDATED_AT,
  };
}

function createClient(ticketOverrides: Record<string, unknown> = {}) {
  const ticket = { ...claimedTicket(), ...ticketOverrides };
  const update = vi.fn();
  const from = vi.fn((table: string) => {
    if (table === 'support_tickets') {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: ticket, error: null }) }) }),
        update,
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({ limit: () => ({ eq: async () => ({
          data: [{ id: ticket.user_id, role: 'member', is_active: true, subscription_status: 'active', awakes_access_expires_at: '2099-01-01T00:00:00.000Z' }],
          error: null,
        }) }) }),
        update,
      };
    }
    if (table === 'coaching_monitor_runs') {
      return {
        select: () => ({ order: () => ({ limit: async () => ({
          data: ['2026-10-16T23:20:00.000Z', '2026-10-16T23:10:00.000Z', '2026-10-16T23:00:00.000Z'].map((checked_at) => ({
            status: 'success',
            checked_at,
            deployment_commit: COMMIT,
            deployment_id: DEPLOYMENT_ID,
            http_status: 200,
            completion_status: 'complete',
            finalization_status: 'complete',
            error: null,
          })),
          error: null,
        }) }) }),
        update,
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  const client = { from, update };
  mocks.createClient.mockReturnValue(client);
  return client;
}

function mockSuccessfulReleaseVerification() {
  vi.mocked(fetch)
    .mockResolvedValueOnce(new Response(JSON.stringify({ sha: COMMIT }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{
      name: 'unit-and-build',
      status: 'completed',
      conclusion: 'success',
    }] }), { status: 200 }));
}
