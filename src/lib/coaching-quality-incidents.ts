import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assessCoachingResponseQuality,
  containsInternalCoachingContextExposure,
  type CoachingQualityIssue,
} from '@/lib/coaching-gemini';
import { COACHING_SCOPE_GUIDANCE } from '@/lib/coaching-scope';

const QUALITY_AUDIT_LOOKBACK_MS = 30 * 60 * 1000;
const QUALITY_AUDIT_HISTORY_MS = 24 * 60 * 60 * 1000;
const DB_PAGE_SIZE = 500;
const SESSION_QUERY_CHUNK_SIZE = 50;
const MAX_CANDIDATE_RESPONSES = 5000;
const MAX_HISTORY_MESSAGES = 25000;

export type CoachingQualityIncidentIssue =
  | 'internal_context_exposure'
  | 'repeated_response_after_dissatisfaction'
  | 'repeated_response_three_times'
  | 'post_delivery_quality_failure'
  | 'quality_safety_hold'
  | 'unresolved_quality_issue';

export type CoachingQualityIncidentSource =
  | 'response_gate'
  | 'scheduled_audit';

export type StoredCoachingMessage = {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};

export type DetectedCoachingQualityIncident = {
  assistantMessageId: string;
  sessionId: string;
  issue: CoachingQualityIncidentIssue;
  messageCreatedAt: string;
  details: Record<string, unknown>;
};

type QualityIncidentInsert = {
  assistant_message_id: string;
  session_id: string;
  user_id: string;
  issue: CoachingQualityIncidentIssue;
  source: CoachingQualityIncidentSource;
  status: 'open';
  message_created_at: string;
  detected_at: string;
  deployment_commit: string | null;
  details: Record<string, unknown>;
  updated_at: string;
};

export function detectStoredCoachingQualityIncidents(params: {
  messages: StoredCoachingMessage[];
  candidateAssistantMessageIds?: Set<string>;
}) {
  const detected: DetectedCoachingQualityIncident[] = [];
  const seen = new Set<string>();
  const messagesBySession = new Map<string, StoredCoachingMessage[]>();

  for (const message of params.messages) {
    const sessionMessages = messagesBySession.get(message.session_id) || [];
    sessionMessages.push(message);
    messagesBySession.set(message.session_id, sessionMessages);
  }

  for (const sessionMessages of messagesBySession.values()) {
    const ordered = [...sessionMessages].sort(
      (left, right) =>
        new Date(left.created_at).getTime() -
        new Date(right.created_at).getTime()
    );

    ordered.forEach((message, index) => {
      if (
        message.role !== 'assistant' ||
        (params.candidateAssistantMessageIds &&
          !params.candidateAssistantMessageIds.has(message.id))
      ) {
        return;
      }

      const add = (
        issue: CoachingQualityIncidentIssue,
        details: Record<string, unknown>
      ) => {
        const key = `${message.id}:${issue}`;
        if (seen.has(key)) return;
        seen.add(key);
        detected.push({
          assistantMessageId: message.id,
          sessionId: message.session_id,
          issue,
          messageCreatedAt: message.created_at,
          details: {
            responseChars: message.content.length,
            ...details,
          },
        });
      };

      const exposesInternalContext = containsInternalCoachingContextExposure(
        message.content
      );
      if (exposesInternalContext) {
        add('internal_context_exposure', { delivered: true });
      }

      if (isExpectedRepeatableResponse(message.content)) return;

      const canonical = canonicalizeResponse(message.content);
      if (canonical.length < 16) return;

      const previousMessages = ordered.slice(0, index);
      const previousUser = [...previousMessages]
        .reverse()
        .find((candidate) => candidate.role === 'user');
      if (previousUser && !exposesInternalContext) {
        const quality = assessCoachingResponseQuality({
          text: message.content,
          lastUserText: previousUser.content,
          historyMessages: previousMessages.map((candidate) => ({
            role: candidate.role,
            content: candidate.content,
          })),
        });
        const severeIssues = quality.issues.filter((issue) =>
          [
            'context_mismatch',
            'dissatisfaction_unanswered',
            'unsafe_high_impact_advice',
            'latest_user_echo',
          ].includes(issue)
        );
        if (severeIssues.length > 0) {
          add('post_delivery_quality_failure', {
            qualityIssues: severeIssues,
            qualityScore: quality.score,
            previousUserMessageId: previousUser.id,
          });
        }
      }
      const matchingAssistants = previousMessages.filter(
        (candidate) =>
          candidate.role === 'assistant' &&
          canonicalizeResponse(candidate.content) === canonical
      );

      if (
        matchingAssistants.length > 0 &&
        previousUser &&
        reportsResponseDissatisfaction(previousUser.content)
      ) {
        add('repeated_response_after_dissatisfaction', {
          repeatCount: matchingAssistants.length + 1,
          previousAssistantMessageId:
            matchingAssistants[matchingAssistants.length - 1]?.id || null,
          previousUserMessageId: previousUser.id,
        });
      }

      if (matchingAssistants.length >= 2) {
        add('repeated_response_three_times', {
          repeatCount: matchingAssistants.length + 1,
          previousAssistantMessageId:
            matchingAssistants[matchingAssistants.length - 1]?.id || null,
        });
      }
    });
  }

  return detected;
}

export async function auditRecentStoredCoachingResponses(
  supabaseAdmin: SupabaseClient,
  options: { now?: Date; lookbackMs?: number } = {}
) {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const detectedAt = now.toISOString();
  const lookbackMs = Math.max(
    60_000,
    options.lookbackMs ?? QUALITY_AUDIT_LOOKBACK_MS
  );
  const candidateSince = new Date(now.getTime() - lookbackMs).toISOString();
  const historySince = new Date(
    now.getTime() - QUALITY_AUDIT_HISTORY_MS
  ).toISOString();

  const candidates = await fetchCandidateResponses(
    supabaseAdmin,
    candidateSince,
    detectedAt
  );
  const sessionIds = [...new Set(candidates.map((row) => row.session_id))];
  if (sessionIds.length === 0) {
    return emptyAuditResult(startedAt);
  }

  const { data: sessions, error: sessionError } = await supabaseAdmin
    .from('chat_sessions')
    .select('id,user_id,title')
    .in('id', sessionIds);
  if (sessionError) {
    throw new Error(
      `coaching quality audit session lookup failed: ${sessionError.message}`
    );
  }

  const userIds = [
    ...new Set((sessions || []).map((session) => String(session.user_id))),
  ];
  const { data: profiles, error: profileError } = userIds.length
    ? await supabaseAdmin.from('profiles').select('id,email').in('id', userIds)
    : { data: [], error: null };
  if (profileError) {
    throw new Error(
      `coaching quality audit profile lookup failed: ${profileError.message}`
    );
  }

  const emailByUserId = new Map(
    (profiles || []).map((profile) => [
      String(profile.id),
      String(profile.email || ''),
    ])
  );
  const userIdBySessionId = new Map<string, string>();
  const eligibleSessionIds = new Set(
    (sessions || [])
      .filter((session) => {
        const email = emailByUserId.get(String(session.user_id)) || '';
        return (
          !isAutomationEmail(email) &&
          String(session.title || '') !== 'ACTI定期監視'
        );
      })
      .map((session) => {
        userIdBySessionId.set(String(session.id), String(session.user_id));
        return String(session.id);
      })
  );
  const eligibleCandidates = candidates.filter((candidate) =>
    eligibleSessionIds.has(candidate.session_id)
  );
  if (eligibleCandidates.length === 0) {
    return emptyAuditResult(startedAt, candidates.length);
  }

  const history = await fetchSessionHistory(
    supabaseAdmin,
    [...eligibleSessionIds],
    historySince,
    detectedAt
  );

  const candidateIds = new Set(eligibleCandidates.map((row) => row.id));
  const incidents = detectStoredCoachingQualityIncidents({
    messages: history,
    candidateAssistantMessageIds: candidateIds,
  });
  const rows = incidents
    .map((incident): QualityIncidentInsert | null => {
      const userId = userIdBySessionId.get(incident.sessionId);
      if (!userId) return null;
      return {
        assistant_message_id: incident.assistantMessageId,
        session_id: incident.sessionId,
        user_id: userId,
        issue: incident.issue,
        source: 'scheduled_audit',
        status: 'open',
        message_created_at: incident.messageCreatedAt,
        detected_at: detectedAt,
        deployment_commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
        details: incident.details,
        updated_at: detectedAt,
      };
    })
    .filter((row): row is QualityIncidentInsert => Boolean(row));

  let persistedIncidents = 0;
  if (rows.length > 0) {
    const { data, error } = await supabaseAdmin
      .from('coaching_quality_incidents')
      .upsert(rows, {
        onConflict: 'assistant_message_id,issue',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error) {
      throw new Error(
        `coaching quality incident persistence failed: ${error.message}`
      );
    }
    persistedIncidents = data?.length || 0;
  }

  return {
    scannedResponses: eligibleCandidates.length,
    scannedSessions: eligibleSessionIds.size,
    detectedIncidents: incidents.length,
    persistedIncidents,
    elapsedMs: Date.now() - startedAt,
  };
}

async function fetchCandidateResponses(
  supabaseAdmin: SupabaseClient,
  candidateSince: string,
  detectedAt: string
) {
  const rows: StoredCoachingMessage[] = [];
  for (let offset = 0; ; offset += DB_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from('chat_messages')
      .select('id,session_id,role,content,created_at')
      .eq('role', 'assistant')
      .gte('created_at', candidateSince)
      .lte('created_at', detectedAt)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + DB_PAGE_SIZE - 1);
    if (error) {
      throw new Error(
        `coaching quality audit candidate lookup failed: ${error.message}`
      );
    }
    const page = (data || []) as StoredCoachingMessage[];
    rows.push(...page);
    if (page.length < DB_PAGE_SIZE) return rows;
    if (rows.length >= MAX_CANDIDATE_RESPONSES) {
      throw new Error(
        `coaching quality audit candidate capacity exceeded: ${rows.length}`
      );
    }
  }
}

async function fetchSessionHistory(
  supabaseAdmin: SupabaseClient,
  sessionIds: string[],
  historySince: string,
  detectedAt: string
) {
  const rows: StoredCoachingMessage[] = [];
  for (
    let chunkStart = 0;
    chunkStart < sessionIds.length;
    chunkStart += SESSION_QUERY_CHUNK_SIZE
  ) {
    const sessionChunk = sessionIds.slice(
      chunkStart,
      chunkStart + SESSION_QUERY_CHUNK_SIZE
    );
    for (let offset = 0; ; offset += DB_PAGE_SIZE) {
      const { data, error } = await supabaseAdmin
        .from('chat_messages')
        .select('id,session_id,role,content,created_at')
        .in('session_id', sessionChunk)
        .in('role', ['user', 'assistant'])
        .gte('created_at', historySince)
        .lte('created_at', detectedAt)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + DB_PAGE_SIZE - 1);
      if (error) {
        throw new Error(
          `coaching quality audit history lookup failed: ${error.message}`
        );
      }
      const page = (data || []) as StoredCoachingMessage[];
      rows.push(...page);
      if (rows.length > MAX_HISTORY_MESSAGES) {
        throw new Error(
          `coaching quality audit history capacity exceeded: ${rows.length}`
        );
      }
      if (page.length < DB_PAGE_SIZE) break;
      if (rows.length >= MAX_HISTORY_MESSAGES) {
        throw new Error(
          `coaching quality audit history capacity exceeded: ${rows.length}`
        );
      }
    }
  }
  return rows;
}

export async function persistResponseGateQualityIncidents(params: {
  supabaseAdmin: SupabaseClient;
  assistantMessageId: string;
  sessionId: string;
  userId: string;
  messageCreatedAt?: string;
  qualityInitialIssues?: CoachingQualityIssue[];
  qualityFinalIssues?: CoachingQualityIssue[];
  qualitySafetyHold?: boolean;
}) {
  const issues = new Set<CoachingQualityIncidentIssue>();
  if (params.qualityInitialIssues?.includes('internal_context_exposure')) {
    issues.add('internal_context_exposure');
  }
  if ((params.qualityFinalIssues?.length || 0) > 0) {
    issues.add('unresolved_quality_issue');
  }
  if (params.qualitySafetyHold) {
    issues.add('quality_safety_hold');
  }
  if (issues.size === 0) return 0;

  const now = new Date().toISOString();
  const rows: QualityIncidentInsert[] = [...issues].map((issue) => ({
    assistant_message_id: params.assistantMessageId,
    session_id: params.sessionId,
    user_id: params.userId,
    issue,
    source: 'response_gate',
    status: 'open',
    message_created_at: params.messageCreatedAt || now,
    detected_at: now,
    deployment_commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    details: {
      unsafeCandidateDelivered: false,
      customerFacingSafetyHold: params.qualitySafetyHold === true,
      qualityInitialIssues: params.qualityInitialIssues || [],
      qualityFinalIssues: params.qualityFinalIssues || [],
      qualitySafetyHold: params.qualitySafetyHold === true,
    },
    updated_at: now,
  }));
  const { data, error } = await params.supabaseAdmin
    .from('coaching_quality_incidents')
    .upsert(rows, {
      onConflict: 'assistant_message_id,issue',
      ignoreDuplicates: true,
    })
    .select('id');
  if (error) {
    throw new Error(
      `coaching response-gate incident persistence failed: ${error.message}`
    );
  }
  return data?.length || 0;
}

function emptyAuditResult(startedAt: number, scannedResponses = 0) {
  return {
    scannedResponses,
    scannedSessions: 0,
    detectedIncidents: 0,
    persistedIncidents: 0,
    elapsedMs: Date.now() - startedAt,
  };
}

function canonicalizeResponse(text: string) {
  return text
    .replace(/\s+/g, '')
    .replace(/[「」『』（）()\[\]【】]/g, '')
    .replace(/[。！？!?、,.:：;；]+$/g, '')
    .trim();
}

function reportsResponseDissatisfaction(text: string) {
  return /何の話|話が(?:違|ずれ)|意味(?:が)?(?:不明|わから)|同じ(?:返事|回答|こと)|答えになっていない|納得(?:できない|いかない)|ちゃんと答えて|前の返答.{0,20}(?:わか(?:ら|り)|短|意味)/.test(
    text.replace(/\s+/g, '')
  );
}

function isExpectedRepeatableResponse(text: string) {
  const normalized = text.trim();
  return (
    normalized === COACHING_SCOPE_GUIDANCE ||
    /^(?:すみません、)?(?:応答|接続|保存|会員情報|利用回数).{0,100}(?:失敗|時間|確認でき|お試しください)/.test(
      normalized
    )
  );
}

function isAutomationEmail(email: string) {
  return (
    /^(?:codex|monitor|acti-monitor|test)[+_.-]/i.test(email) ||
    /@example\.(?:com|net|org)$/i.test(email)
  );
}
