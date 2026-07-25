import { describe, expect, it } from 'vitest';
import {
  canAutomationSendCustomerReply,
  evaluateSupportAutomationPolicy,
  validateSupportReplyIdempotencyKey,
  validateSupportReplyClaims,
  validateSupportResolutionEvidence,
} from '@/lib/support-automation-policy';

describe('support automation policy', () => {
  it('allows a verified technical complaint to enter automatic handling', () => {
    const policy = evaluateSupportAutomationPolicy({
      category: 'bug',
      subject: 'AIコーチングが止まります',
      message: '3回目の送信で読み込み中のまま進みません。',
    });

    expect(policy).toEqual({ decisionRequired: false, reasons: [] });
    expect(
      canAutomationSendCustomerReply({
        classification: 'technical',
        policyDecisionRequired: policy.decisionRequired,
      })
    ).toBe(true);
  });

  it('does not mistake a paid-member technical complaint for a pricing decision', () => {
    const policy = evaluateSupportAutomationPolicy({
      category: 'bug',
      subject: '有料会員なのに送信できません',
      message: '料金を支払っていますが、3回目で止まります。',
    });

    expect(policy.decisionRequired).toBe(false);
  });

  it.each([
    ['billing category', 'billing', 'ログインできません', '確認してください'],
    ['refund', 'bug', '返金について', '返金を希望します'],
    ['cancellation', 'general', '退会', '契約を解約したいです'],
    ['limit policy', 'feature', '利用制限', '利用上限を撤廃してください'],
  ])('holds %s for a decision', (_label, category, subject, message) => {
    const policy = evaluateSupportAutomationPolicy({
      category,
      subject,
      message,
    });

    expect(policy.decisionRequired).toBe(true);
    expect(
      canAutomationSendCustomerReply({
        classification: 'technical',
        policyDecisionRequired: policy.decisionRequired,
      })
    ).toBe(false);
  });

  it('requires full production evidence before a technical fix reply', () => {
    expect(
      validateSupportResolutionEvidence({
        resolutionKind: 'technical_fix',
        evidence: {
          productionCommit: 'c32f36538f43b568949285809c605e7ecac31cc7',
          productionDeploymentId: 'dpl_9UJdG4pw8Fw2CVgsV3hXFmGe6PJM',
          monitorSuccesses: 2,
          observationMinutes: 20,
          releaseGatePassed: true,
        },
      })
    ).toContain('3回連続');

    expect(
      validateSupportResolutionEvidence({
        resolutionKind: 'technical_fix',
        evidence: {
          productionCommit: 'c32f36538f43b568949285809c605e7ecac31cc7',
          productionDeploymentId: 'dpl_9UJdG4pw8Fw2CVgsV3hXFmGe6PJM',
          monitorSuccesses: 3,
          observationMinutes: 20,
          releaseGatePassed: true,
        },
      })
    ).toBe('');
  });

  it('requires primary-source verification before an account fix reply', () => {
    expect(
      validateSupportResolutionEvidence({
        resolutionKind: 'account_fix',
        evidence: { accountVerified: false },
      })
    ).toContain('一次情報');
  });

  it('does not allow an unverified no-defect reply', () => {
    expect(
      validateSupportResolutionEvidence({
        resolutionKind: 'no_defect',
        evidence: { investigationVerified: false },
      })
    ).toContain('一次情報');
  });
});

describe('validateSupportReplyClaims', () => {
  it('blocks completion wording when no technical or account evidence is required', () => {
    expect(
      validateSupportReplyClaims({
        resolutionKind: 'progress',
        message: 'システムは修正しました。ご利用ください。',
      })
    ).toContain('検証記録');
  });

  it('allows verified completion wording for a technical fix', () => {
    expect(
      validateSupportReplyClaims({
        resolutionKind: 'technical_fix',
        message: 'システムの修正が完了しました。',
      })
    ).toBe('');
  });
});

describe('validateSupportReplyIdempotencyKey', () => {
  const ticketId = 'ad7c4e6a-8f28-4594-9676-a7a1e20b25ba';

  it('requires the ticket id so provider idempotency cannot collide across tickets', () => {
    expect(
      validateSupportReplyIdempotencyKey(ticketId, 'resolution-shared-key')
    ).toContain('チケットID');
  });

  it('accepts a ticket-specific key', () => {
    expect(
      validateSupportReplyIdempotencyKey(
        ticketId,
        `resolution-${ticketId}-verified`
      )
    ).toBe('');
  });
});
