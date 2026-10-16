export type SupportAutomationResolutionKind =
  | 'technical_fix'
  | 'account_fix'
  | 'usage_answer'
  | 'no_defect'
  | 'progress';

export type SupportAutomationClassification =
  | 'technical'
  | 'account'
  | 'usage'
  | 'product_feedback'
  | 'business_decision'
  | 'billing'
  | 'legal';

export const SUPPORT_AUTOMATION_RESOLUTION_KINDS =
  new Set<SupportAutomationResolutionKind>([
    'technical_fix',
    'account_fix',
    'usage_answer',
    'no_defect',
    'progress',
  ]);

export const SUPPORT_AUTOMATION_CLASSIFICATIONS =
  new Set<SupportAutomationClassification>([
    'technical',
    'account',
    'usage',
    'product_feedback',
    'business_decision',
    'billing',
    'legal',
  ]);

const BLOCKED_CLASSIFICATIONS = new Set<SupportAutomationClassification>([
  'business_decision',
  'billing',
  'legal',
]);

const BUSINESS_DECISION_PATTERNS = [
  { code: 'refund', pattern: /返金|払い戻し/ },
  {
    code: 'pricing-decision',
    pattern:
      /料金.{0,8}(?:変更|値上げ|値下げ|交渉|免除)|価格.{0,8}(?:変更|交渉)|請求.{0,8}(?:取消|減額|免除)/,
  },
  { code: 'contract', pattern: /解約|退会|キャンセル|契約|規約/ },
  { code: 'privacy', pattern: /個人情報|データ削除|アカウント削除/ },
  { code: 'usage-policy', pattern: /利用制限.*撤廃|上限.*(?:変更|撤廃)|無制限/ },
  { code: 'mass-communication', pattern: /一斉配信|全体配信/ },
  {
    code: 'legal-claim',
    pattern: /損害賠償|補償.{0,8}(?:要求|請求)|弁護士|訴訟|法的措置/,
  },
];

const VERIFIED_COMPLETION_PATTERN =
  /修正(?:しました|済み)|復旧(?:しました|済み)|解消(?:しました|済み)|直りました|対応(?:が)?完了|正常に(?:ご)?利用/;

const PROGRESS_REPLY_ERROR =
  '自動サポートから途中連絡は送信できません。対応完了後に最終回答をまとめて送信してください';
const SUPPORT_WORK_PATTERN = '(?:調査|確認|修正|対応|検証|監視|観測)(?:作業)?';
const ONGOING_SUPPORT_WORK_PATTERN = new RegExp(
  `${SUPPORT_WORK_PATTERN}(?:と${SUPPORT_WORK_PATTERN})*(?:を|は)?(?:引き続き|現在も?|今も)?(?:中(?:です|でございます|のため|につき)|(?:進めて|続けて|継続して|実施して|行って|して)(?:います|おります|いるところです)|しております)`
);

export function evaluateSupportAutomationPolicy(ticket: {
  category: string;
  subject: string;
  message: string;
}) {
  const reasons = new Set<string>();
  if (ticket.category === 'billing') {
    reasons.add('billing-category');
  }

  const text = `${ticket.subject}\n${ticket.message}`;
  for (const rule of BUSINESS_DECISION_PATTERNS) {
    if (rule.pattern.test(text)) reasons.add(rule.code);
  }

  return {
    decisionRequired: reasons.size > 0,
    reasons: Array.from(reasons),
  };
}

export function canAutomationSendCustomerReply(params: {
  classification: SupportAutomationClassification;
  policyDecisionRequired: boolean;
  decisionProvided?: boolean;
}) {
  if (params.decisionProvided) {
    return true;
  }

  return (
    !params.policyDecisionRequired &&
    !BLOCKED_CLASSIFICATIONS.has(params.classification)
  );
}

export function validateSupportResolutionEvidence(params: {
  resolutionKind: SupportAutomationResolutionKind;
  evidence?: Record<string, unknown> | null;
}) {
  const evidence = params.evidence || {};

  if (params.resolutionKind === 'progress') {
    return PROGRESS_REPLY_ERROR;
  }

  if (params.resolutionKind === 'technical_fix') {
    const productionCommit =
      typeof evidence.productionCommit === 'string'
        ? evidence.productionCommit
        : '';
    const productionDeploymentId =
      typeof evidence.productionDeploymentId === 'string'
        ? evidence.productionDeploymentId
        : '';
    const monitorSuccesses = evidence.monitorSuccesses;
    const observationMinutes = evidence.observationMinutes;

    if (!/^[0-9a-f]{40}$/i.test(productionCommit)) {
      return '本番コミットSHAの検証記録が必要です';
    }
    if (!/^dpl_[A-Za-z0-9]+$/.test(productionDeploymentId)) {
      return '本番デプロイIDの検証記録が必要です';
    }
    if (
      typeof monitorSuccesses !== 'number' ||
      !Number.isFinite(monitorSuccesses) ||
      !Number.isInteger(monitorSuccesses) ||
      monitorSuccesses < 3 ||
      typeof observationMinutes !== 'number' ||
      !Number.isFinite(observationMinutes) ||
      observationMinutes < 20
    ) {
      return '20分以上・3回連続の本番監視成功が必要です';
    }
    if (evidence.releaseGatePassed !== true) {
      return 'リリースゲート完了の検証記録が必要です';
    }
  }

  if (
    params.resolutionKind === 'account_fix' &&
    evidence.accountVerified !== true
  ) {
    return 'アカウント状態を一次情報で確認した記録が必要です';
  }

  if (
    params.resolutionKind === 'no_defect' &&
    evidence.investigationVerified !== true
  ) {
    return '障害ではないと判断した一次情報の確認記録が必要です';
  }

  return '';
}

export function validateSupportReplyResolutionKind(params: {
  classification: SupportAutomationClassification;
  resolutionKind: SupportAutomationResolutionKind;
}) {
  if (params.resolutionKind === 'progress') {
    return PROGRESS_REPLY_ERROR;
  }

  if (
    (params.classification === 'technical' &&
      !['technical_fix', 'no_defect'].includes(params.resolutionKind)) ||
    (params.classification === 'account' &&
      !['account_fix', 'no_defect'].includes(params.resolutionKind))
  ) {
    return '問い合わせの分類に対応する解決種別と検証記録が必要です';
  }

  return '';
}

export function validateSupportReplyClaims(params: {
  resolutionKind: SupportAutomationResolutionKind;
  message: string;
}) {
  // Quoted screen text and past correspondence do not assert our current work status.
  const unquotedMessage = params.message
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g, '')
    .replace(/^>.*$/gm, '');
  if (ONGOING_SUPPORT_WORK_PATTERN.test(unquotedMessage)) {
    return PROGRESS_REPLY_ERROR;
  }

  if (
    !['technical_fix', 'account_fix'].includes(params.resolutionKind) &&
    VERIFIED_COMPLETION_PATTERN.test(params.message)
  ) {
    return '修正・復旧完了を案内するには technical_fix または account_fix の検証記録が必要です';
  }

  return '';
}

export function validateSupportReplyIdempotencyKey(
  ticketId: string,
  idempotencyKey: string
) {
  if (!/^[A-Za-z0-9_-]{8,180}$/.test(idempotencyKey)) {
    return '有効な重複防止キーが必要です';
  }
  if (!idempotencyKey.includes(ticketId)) {
    return '重複防止キーには対象チケットIDが必要です';
  }

  return '';
}
