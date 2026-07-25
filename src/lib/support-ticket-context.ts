import {
  SUPPORT_REPLY_LOG_HEADER,
  SUPPORT_TECHNICAL_CONTEXT_HEADER,
} from '@/lib/support-message-markers';

export { SUPPORT_TECHNICAL_CONTEXT_HEADER };

const MAX_SOURCE_LENGTH = 40;
const MAX_PAGE_PATH_LENGTH = 300;
const MAX_USER_AGENT_LENGTH = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SupportTechnicalContext = {
  source: string;
  sessionId: string | null;
  pagePath: string | null;
  userAgent: string | null;
  deploymentCommit: string | null;
  reportedAt: string;
};

export function normalizeSupportTechnicalContext(input: {
  source?: unknown;
  sessionId?: unknown;
  pagePath?: unknown;
  userAgent?: unknown;
  deploymentCommit?: unknown;
  reportedAt?: unknown;
}): SupportTechnicalContext {
  const source = toSafeText(input.source, MAX_SOURCE_LENGTH) || 'support';
  const rawSessionId = toSafeText(input.sessionId, 80);
  const rawPagePath = toSafeText(input.pagePath, MAX_PAGE_PATH_LENGTH);
  const deploymentCommit = toSafeText(input.deploymentCommit, 64);
  const reportedAt = toSafeText(input.reportedAt, 40);

  return {
    source,
    sessionId: UUID_PATTERN.test(rawSessionId) ? rawSessionId : null,
    pagePath:
      rawPagePath.startsWith('/') && !rawPagePath.startsWith('//')
        ? rawPagePath
        : null,
    userAgent: toSafeText(input.userAgent, MAX_USER_AGENT_LENGTH) || null,
    deploymentCommit: /^[0-9a-f]{7,40}$/i.test(deploymentCommit)
      ? deploymentCommit
      : null,
    reportedAt: isValidDate(reportedAt)
      ? new Date(reportedAt).toISOString()
      : new Date().toISOString(),
  };
}

export function appendSupportTechnicalContext(
  message: string,
  context: SupportTechnicalContext
) {
  const contextMarker = message.indexOf(SUPPORT_TECHNICAL_CONTEXT_HEADER);
  const replyMarker = message.indexOf(SUPPORT_REPLY_LOG_HEADER);
  const firstInternalMarker = [contextMarker, replyMarker]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const baseMessage =
    firstInternalMarker === undefined
      ? message.trimEnd()
      : message.slice(0, firstInternalMarker).trimEnd();
  const replyLog =
    replyMarker >= 0 ? message.slice(replyMarker).trimEnd() : '';

  return [
    `${baseMessage}${SUPPORT_TECHNICAL_CONTEXT_HEADER}${JSON.stringify(context)}`,
    replyLog,
  ]
    .filter(Boolean)
    .join('');
}

export function parseSupportTechnicalContext(value: string) {
  if (!value.trim()) return null;

  try {
    return normalizeSupportTechnicalContext(JSON.parse(value));
  } catch {
    return null;
  }
}

function toSafeText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isValidDate(value: string) {
  if (!value) return false;
  return Number.isFinite(new Date(value).getTime());
}
