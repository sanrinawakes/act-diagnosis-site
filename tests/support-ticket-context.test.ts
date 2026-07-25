import { describe, expect, it } from 'vitest';
import {
  appendSupportTechnicalContext,
  normalizeSupportTechnicalContext,
} from '@/lib/support-ticket-context';
import {
  appendSupportReplyLog,
  buildSupportAutomationNoteEntry,
  buildSupportReplyLogEntry,
  getLatestSupportAutomationClaimRunId,
  hasSupportLogIdempotencyKey,
  hasSupportReplyIdempotencyKey,
  splitSupportMessage,
} from '@/lib/support-reply-log';

describe('support ticket technical context', () => {
  it('stores technical context outside the customer message', () => {
    const context = normalizeSupportTechnicalContext({
      source: 'coaching',
      sessionId: 'a36b1a82-dd24-41f2-8382-5bb9b8730ab3',
      pagePath: '/support?source=coaching',
      userAgent: 'Mobile Safari',
      deploymentCommit: 'c32f36538f43b568949285809c605e7ecac31cc7',
      reportedAt: '2026-07-25T12:00:00.000Z',
    });
    const stored = appendSupportTechnicalContext('送信できません', context);
    const parsed = splitSupportMessage(stored);

    expect(parsed.customerMessage).toBe('送信できません');
    expect(parsed.technicalContext).toEqual(context);
    expect(parsed.replyLog).toBe('');
  });

  it('rejects forged session ids and external page URLs', () => {
    const context = normalizeSupportTechnicalContext({
      source: 'coaching',
      sessionId: 'not-a-session',
      pagePath: 'https://example.com/steal',
      deploymentCommit: 'not-a-sha',
    });

    expect(context.sessionId).toBeNull();
    expect(context.pagePath).toBeNull();
    expect(context.deploymentCommit).toBeNull();
  });

  it('preserves reply history when technical context is refreshed', () => {
    const firstContext = normalizeSupportTechnicalContext({
      source: 'support',
    });
    const reply = buildSupportReplyLogEntry({
      sentAt: '2026-07-25T12:00:00.000Z',
      senderEmail: 'ACTI自動受付',
      toEmail: 'member@example.com',
      subject: '受付',
      body: '受け付けました。',
      deliveryStatus: 'sent',
      idempotencyKey: 'receipt-ticket-12345678',
    });
    const withReply = appendSupportReplyLog(
      appendSupportTechnicalContext('問い合わせ本文', firstContext),
      reply
    );
    const updated = appendSupportTechnicalContext(
      withReply,
      normalizeSupportTechnicalContext({
        source: 'coaching',
        sessionId: 'a36b1a82-dd24-41f2-8382-5bb9b8730ab3',
      })
    );
    const parsed = splitSupportMessage(updated);

    expect(parsed.customerMessage).toBe('問い合わせ本文');
    expect(parsed.technicalContext?.source).toBe('coaching');
    expect(parsed.replyLog).toContain('受け付けました。');
    expect(
      hasSupportReplyIdempotencyKey(updated, 'receipt-ticket-12345678')
    ).toBe(true);
    expect(
      hasSupportLogIdempotencyKey(updated, 'receipt-ticket-12345678')
    ).toBe(true);
  });

  it('does not treat a failed delivery log as a completed send', () => {
    const failed = buildSupportReplyLogEntry({
      sentAt: '2026-07-25T12:00:00.000Z',
      senderEmail: 'ACTI自動サポート',
      toEmail: 'member@example.com',
      subject: '確認結果',
      body: '確認しました。',
      deliveryStatus: 'failed',
      idempotencyKey: 'resolution-ticket-12345678',
    });
    const message = appendSupportReplyLog('問い合わせ本文', failed);

    expect(
      hasSupportReplyIdempotencyKey(message, 'resolution-ticket-12345678')
    ).toBe(false);
    expect(
      hasSupportLogIdempotencyKey(message, 'resolution-ticket-12345678')
    ).toBe(true);
  });

  it('returns only the most recent automation claim owner', () => {
    const first = buildSupportAutomationNoteEntry({
      recordedAt: '2026-07-25T12:00:00.000Z',
      automationRunId: 'automation_run_001',
      idempotencyKey: 'claim-automation_run_001',
      status: 'claimed',
      note: '開始',
    });
    const second = buildSupportAutomationNoteEntry({
      recordedAt: '2026-07-25T14:00:00.000Z',
      automationRunId: 'automation_run_002',
      idempotencyKey: 'claim-automation_run_002',
      status: 'claimed',
      note: '引き継ぎ',
    });
    const message = appendSupportReplyLog(
      appendSupportReplyLog('問い合わせ本文', first),
      second
    );

    expect(getLatestSupportAutomationClaimRunId(message)).toBe(
      'automation_run_002'
    );
  });
});
