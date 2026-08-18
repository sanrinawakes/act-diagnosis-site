import { timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import {
  canAutomationSendCustomerReply,
  evaluateSupportAutomationPolicy,
  SUPPORT_AUTOMATION_CLASSIFICATIONS,
  SUPPORT_AUTOMATION_RESOLUTION_KINDS,
  validateSupportReplyIdempotencyKey,
  validateSupportReplyClaims,
  validateSupportResolutionEvidence,
  type SupportAutomationClassification,
  type SupportAutomationResolutionKind,
} from '@/lib/support-automation-policy';
import {
  appendSupportReplyLog,
  buildSupportAutomationNoteEntry,
  getSupportDecisionState,
  getLatestSupportAutomationClaimRunId,
  hasSupportLogIdempotencyKey,
  hasSupportReplyIdempotencyKey,
  splitSupportMessage,
} from '@/lib/support-reply-log';
import { extractSupportInboundCustomerMessages } from '@/lib/support-inbound';
import { deliverSupportDecisionRequest } from '@/lib/server/support-decision-email';
import { deliverSupportReply } from '@/lib/server/support-email';
import { hasCoachingAccess } from '@/lib/coaching-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CLAIM_LEASE_MS = 45 * 60 * 1000;
const MAX_QUEUE_ITEMS = 20;
const MAX_SUPPORT_SCAN_ITEMS = 500;
const MAX_RECENT_MONITOR_FAILURES = 200;
const MAX_QUALITY_INCIDENT_SCAN_ITEMS = 200;
const RECENT_MONITOR_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUTOMATION_START_AT = '2026-07-25T00:00:00.000Z';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type SupportTicket = {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type CoachingQualityIncident = {
  id: string;
  assistant_message_id: string;
  session_id: string;
  user_id: string;
  issue: string;
  source: string;
  status: string;
  message_created_at: string;
  detected_at: string;
  deployment_commit: string | null;
  details: Record<string, unknown>;
  claimed_run_id: string | null;
  claimed_at: string | null;
  updated_at: string;
};

function createAdminClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

export async function GET(request: NextRequest) {
  const authorizationError = validateAutomationAuthorization(request);
  if (authorizationError) {
    return NextResponse.json(
      { error: authorizationError },
      { status: authorizationError === 'Unauthorized' ? 401 : 503 }
    );
  }

  try {
    const limit = Math.min(
      Math.max(Number(request.nextUrl.searchParams.get('limit')) || 10, 1),
      MAX_QUEUE_ITEMS
    );
    const createdAfter = getCreatedAfter(
      request.nextUrl.searchParams.get('created_after')
    );
    const client = createAdminClient();
    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
    const { data, error } = await client
      .from('support_tickets')
      .select('*')
      .in('status', ['open', 'in_progress'])
      .gte('updated_at', createdAfter)
      .order('updated_at', { ascending: true })
      .limit(MAX_SUPPORT_SCAN_ITEMS);

    if (error) throw error;

    const scannedTickets = (data || []) as SupportTicket[];
    const queue = scannedTickets
      .filter((ticket) => {
        const decisionState = getSupportDecisionState(
          ticket.message || '',
          ticket.id
        );
        return (
          !decisionState.pending &&
          (ticket.status === 'open' ||
            (ticket.status === 'in_progress' &&
              ticket.updated_at < staleBefore))
        );
      })
      .slice(0, limit);
    const pendingDecisionTickets = scannedTickets.filter(
      (ticket) =>
        getSupportDecisionState(ticket.message || '', ticket.id).pending
    );
    const pendingDecisionQueue = pendingDecisionTickets.slice(0, limit);
    const { data: monitors, error: monitorError } = await client
      .from('coaching_monitor_runs')
      .select(
        'id,status,checked_at,deployment_commit,deployment_id,elapsed_ms,http_status,first_chunk_ms,chat_total_ms,completion_status,finalization_status,error'
      )
      .order('checked_at', { ascending: false })
      .limit(6);

    if (monitorError) throw monitorError;

    const monitorFailureSince = new Date(
      Date.now() - RECENT_MONITOR_FAILURE_WINDOW_MS
    ).toISOString();
    const { data: monitorFailures, error: monitorFailureError } = await client
      .from('coaching_monitor_runs')
      .select(
        'id,status,checked_at,deployment_commit,deployment_id,elapsed_ms,http_status,first_chunk_ms,chat_total_ms,completion_status,finalization_status,error'
      )
      .eq('status', 'failure')
      .gte('checked_at', monitorFailureSince)
      .order('checked_at', { ascending: false })
      .limit(MAX_RECENT_MONITOR_FAILURES);

    if (monitorFailureError) throw monitorFailureError;

    const { data: rawQualityIncidents, error: qualityIncidentError } =
      await client
        .from('coaching_quality_incidents')
        .select(
          'id,assistant_message_id,session_id,user_id,issue,source,status,message_created_at,detected_at,deployment_commit,details,claimed_run_id,claimed_at,updated_at'
        )
        .in('status', ['open', 'in_progress'])
        .order('detected_at', { ascending: true })
        .limit(MAX_QUALITY_INCIDENT_SCAN_ITEMS);
    if (qualityIncidentError) throw qualityIncidentError;
    const qualityIncidents = (
      (rawQualityIncidents || []) as CoachingQualityIncident[]
    ).filter(
      (incident) =>
        incident.status === 'open' ||
        (incident.status === 'in_progress' &&
          (!incident.claimed_at || incident.claimed_at < staleBefore))
    );

    const [tickets, pendingDecisions, qualityIncidentQueue] = await Promise.all([
      Promise.all(queue.map((ticket) => enrichTicketContext(client, ticket))),
      Promise.all(
        pendingDecisionQueue.map((ticket) =>
          enrichTicketContext(client, ticket)
        )
      ),
      Promise.all(
        qualityIncidents
          .slice(0, limit)
          .map((incident) => enrichQualityIncidentContext(client, incident))
      ),
    ]);

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      created_after: createdAfter,
      claim_lease_minutes: CLAIM_LEASE_MS / 60_000,
      queue_count: tickets.length,
      tickets,
      pending_decision_count: pendingDecisionTickets.length,
      pending_decisions: pendingDecisions,
      latest_coaching_monitors: monitors || [],
      recent_coaching_failures: monitorFailures || [],
      open_coaching_quality_incident_count: qualityIncidents.length,
      open_coaching_quality_incidents: qualityIncidentQueue,
    });
  } catch (error) {
    console.error('GET /api/internal/support-automation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Queue lookup failed' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const authorizationError = validateAutomationAuthorization(request);
  if (authorizationError) {
    return NextResponse.json(
      { error: authorizationError },
      { status: authorizationError === 'Unauthorized' ? 401 : 503 }
    );
  }

  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const action = toSafeText(body.action, 40);
    const runId = toSafeText(body.run_id, 120);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(runId)) {
      return NextResponse.json(
        { error: 'Valid run_id is required' },
        { status: 400 }
      );
    }

    const client = createAdminClient();
    if (action.startsWith('quality_')) {
      const incidentId = toSafeText(body.quality_incident_id, 80);
      if (!isUuid(incidentId)) {
        return NextResponse.json(
          { error: 'Valid quality_incident_id is required' },
          { status: 400 }
        );
      }
      if (action === 'quality_claim') {
        return claimQualityIncident(client, incidentId, runId);
      }
      if (action === 'quality_heartbeat') {
        return heartbeatQualityIncident(client, incidentId, runId);
      }
      if (action === 'quality_release') {
        return releaseQualityIncident(client, incidentId, runId);
      }
      if (action === 'quality_resolve') {
        return resolveQualityIncident(client, incidentId, runId, body);
      }
      return NextResponse.json({ error: 'Unknown quality action' }, { status: 400 });
    }

    const ticketId = toSafeText(body.ticket_id, 80);
    if (!isUuid(ticketId)) {
      return NextResponse.json(
        { error: 'Valid ticket_id and run_id are required' },
        { status: 400 }
      );
    }

    if (action === 'claim') {
      return claimTicket(client, ticketId, runId);
    }
    if (action === 'heartbeat') {
      return heartbeatTicket(client, ticketId, runId);
    }
    if (action === 'release') {
      return releaseTicket(client, ticketId, runId);
    }
    if (action === 'hold') {
      return holdTicket(client, ticketId, runId, body);
    }
    if (action === 'decision') {
      return recordBusinessDecision(client, ticketId, runId, body);
    }
    if (action === 'reply') {
      return replyToTicket(client, ticketId, runId, body);
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('POST /api/internal/support-automation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Automation action failed' },
      { status: 500 }
    );
  }
}

async function claimQualityIncident(
  client: SupabaseClient,
  incidentId: string,
  runId: string
) {
  const incident = await getQualityIncident(client, incidentId);
  if (incident.status === 'resolved' || incident.status === 'ignored') {
    return NextResponse.json(
      { error: `Quality incident is already ${incident.status}` },
      { status: 409 }
    );
  }

  const isStale =
    incident.status === 'in_progress' &&
    (!incident.claimed_at ||
      Date.now() - new Date(incident.claimed_at).getTime() >= CLAIM_LEASE_MS);
  if (
    incident.status === 'in_progress' &&
    !isStale &&
    incident.claimed_run_id === runId
  ) {
    return NextResponse.json({
      success: true,
      claimed: true,
      already_claimed: true,
      run_id: runId,
      quality_incident: incident,
    });
  }
  if (incident.status === 'in_progress' && !isStale) {
    return NextResponse.json(
      { error: 'Quality incident is already claimed' },
      { status: 409 }
    );
  }

  const claimedAt = new Date().toISOString();
  let query = client
    .from('coaching_quality_incidents')
    .update({
      status: 'in_progress',
      claimed_run_id: runId,
      claimed_at: claimedAt,
      updated_at: claimedAt,
    })
    .eq('id', incidentId);
  query =
    incident.status === 'open'
      ? query.eq('status', 'open')
      : query.eq('updated_at', incident.updated_at);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw error;
  if (!data) {
    return NextResponse.json(
      { error: 'Quality incident was claimed by another run' },
      { status: 409 }
    );
  }
  return NextResponse.json({
    success: true,
    claimed: true,
    run_id: runId,
    quality_incident: data,
  });
}

async function heartbeatQualityIncident(
  client: SupabaseClient,
  incidentId: string,
  runId: string
) {
  const incident = await getQualityIncident(client, incidentId);
  const ownershipError = validateQualityIncidentOwnership(incident, runId);
  if (ownershipError) {
    return NextResponse.json({ error: ownershipError }, { status: 409 });
  }
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('coaching_quality_incidents')
    .update({ claimed_at: now, updated_at: now })
    .eq('id', incidentId)
    .eq('status', 'in_progress')
    .eq('claimed_run_id', runId)
    .eq('updated_at', incident.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;
  return NextResponse.json({ success: Boolean(data), quality_incident: data });
}

async function releaseQualityIncident(
  client: SupabaseClient,
  incidentId: string,
  runId: string
) {
  const incident = await getQualityIncident(client, incidentId);
  const ownershipError = validateQualityIncidentOwnership(incident, runId);
  if (ownershipError) {
    return NextResponse.json({ error: ownershipError }, { status: 409 });
  }
  const { data, error } = await client
    .from('coaching_quality_incidents')
    .update({
      status: 'open',
      claimed_run_id: null,
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', incidentId)
    .eq('status', 'in_progress')
    .eq('claimed_run_id', runId)
    .eq('updated_at', incident.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;
  return NextResponse.json({ success: Boolean(data), quality_incident: data });
}

async function resolveQualityIncident(
  client: SupabaseClient,
  incidentId: string,
  runId: string,
  body: Record<string, unknown>
) {
  const incident = await getQualityIncident(client, incidentId);
  const ownershipError = validateQualityIncidentOwnership(incident, runId);
  if (ownershipError) {
    return NextResponse.json({ error: ownershipError }, { status: 409 });
  }
  const resolutionKind = toSafeText(body.resolution_kind, 40);
  const resolutionNote = toSafeText(body.resolution_note, 4000);
  if (
    !['technical_fix', 'false_positive', 'no_code_change'].includes(
      resolutionKind
    ) ||
    !resolutionNote
  ) {
    return NextResponse.json(
      { error: 'Valid resolution_kind and resolution_note are required' },
      { status: 400 }
    );
  }
  const evidence =
    body.evidence && typeof body.evidence === 'object'
      ? (body.evidence as Record<string, unknown>)
      : {};
  if (resolutionKind === 'technical_fix') {
    const releaseEvidenceError = await verifyTechnicalReleaseEvidence(
      client,
      evidence
    );
    if (releaseEvidenceError) {
      return NextResponse.json(
        { error: releaseEvidenceError },
        { status: 409 }
      );
    }
  }

  const resolvedAt = new Date().toISOString();
  const status = resolutionKind === 'false_positive' ? 'ignored' : 'resolved';
  const { data, error } = await client
    .from('coaching_quality_incidents')
    .update({
      status,
      resolution_kind: resolutionKind,
      resolution_note: resolutionNote,
      resolution_evidence: evidence,
      resolved_at: resolvedAt,
      updated_at: resolvedAt,
    })
    .eq('id', incidentId)
    .eq('status', 'in_progress')
    .eq('claimed_run_id', runId)
    .eq('updated_at', incident.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return NextResponse.json(
      { error: 'Quality incident changed while resolving it' },
      { status: 409 }
    );
  }
  return NextResponse.json({ success: true, quality_incident: data });
}

async function claimTicket(
  client: SupabaseClient,
  ticketId: string,
  runId: string
) {
  const ticket = await getTicket(client, ticketId);
  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    return NextResponse.json(
      { error: `Ticket is already ${ticket.status}` },
      { status: 409 }
    );
  }

  const isStale =
    ticket.status === 'in_progress' &&
    Date.now() - new Date(ticket.updated_at).getTime() >= CLAIM_LEASE_MS;
  const currentClaimRunId = getLatestSupportAutomationClaimRunId(
    ticket.message || ''
  );
  if (
    ticket.status === 'in_progress' &&
    !isStale &&
    currentClaimRunId === runId
  ) {
    return NextResponse.json({
      success: true,
      claimed: true,
      already_claimed: true,
      run_id: runId,
      ticket,
    });
  }
  if (ticket.status === 'in_progress' && !isStale) {
    return NextResponse.json(
      { error: 'Ticket is already claimed' },
      { status: 409 }
    );
  }

  const claimedAt = new Date().toISOString();
  const claimKey = `claim-${runId}`;
  const nextMessage = hasSupportLogIdempotencyKey(
    ticket.message || '',
    claimKey
  )
    ? ticket.message || ''
    : appendSupportReplyLog(
        ticket.message || '',
        buildSupportAutomationNoteEntry({
          recordedAt: claimedAt,
          automationRunId: runId,
          idempotencyKey: claimKey,
          status: 'claimed',
          note: '自動調査を開始しました。',
        })
      );
  let query = client
    .from('support_tickets')
    .update({
      message: nextMessage,
      status: 'in_progress',
      updated_at: claimedAt,
    })
    .eq('id', ticketId);
  query =
    ticket.status === 'open'
      ? query.eq('status', 'open')
      : query.eq('updated_at', ticket.updated_at);

  const { data, error } = await query.select().maybeSingle();
  if (error) throw error;
  if (!data) {
    return NextResponse.json(
      { error: 'Ticket was claimed by another run' },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true, claimed: true, run_id: runId, ticket: data });
}

async function heartbeatTicket(
  client: SupabaseClient,
  ticketId: string,
  runId: string
) {
  const ticket = await getTicket(client, ticketId);
  const ownershipError = validateClaimOwnership(ticket, runId);
  if (ownershipError) {
    return NextResponse.json({ error: ownershipError }, { status: 409 });
  }

  const { data, error } = await client
    .from('support_tickets')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', ticketId)
    .eq('status', 'in_progress')
    .eq('updated_at', ticket.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;

  return NextResponse.json({ success: Boolean(data), ticket: data || null });
}

async function releaseTicket(
  client: SupabaseClient,
  ticketId: string,
  runId: string
) {
  const ticket = await getTicket(client, ticketId);
  const ownershipError = validateClaimOwnership(ticket, runId);
  if (ownershipError) {
    return NextResponse.json({ error: ownershipError }, { status: 409 });
  }

  const { data, error } = await client
    .from('support_tickets')
    .update({ status: 'open', updated_at: new Date().toISOString() })
    .eq('id', ticketId)
    .eq('status', 'in_progress')
    .eq('updated_at', ticket.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;

  return NextResponse.json({ success: Boolean(data), ticket: data || null });
}

async function holdTicket(
  client: SupabaseClient,
  ticketId: string,
  runId: string,
  body: Record<string, unknown>
) {
  const ticket = await getTicket(client, ticketId);
  const ownershipError = validateClaimOwnership(ticket, runId);
  if (ownershipError) {
    return NextResponse.json({ error: ownershipError }, { status: 409 });
  }
  const reason = toSafeText(body.reason, 1000);
  if (!reason) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  }
  const parsed = splitSupportMessage(ticket.message || '');
  const policy = evaluateSupportAutomationPolicy({
    category: ticket.category,
    subject: ticket.subject,
    message: parsed.customerMessage,
  });
  if (!policy.decisionRequired) {
    return NextResponse.json(
      {
        error:
          'This ticket does not require a business, financial, contractual, or legal decision',
      },
      { status: 409 }
    );
  }

  const noteKey = `decision-${ticketId}`;
  let nextMessage = ticket.message || '';
  const decisionState = getSupportDecisionState(nextMessage, ticketId);
  if (decisionState.provided) {
    return NextResponse.json(
      { error: 'A business decision has already been provided for this ticket' },
      { status: 409 }
    );
  }
  let decisionNotification:
    | Awaited<ReturnType<typeof deliverSupportDecisionRequest>>
    | null = null;
  if (!hasSupportLogIdempotencyKey(nextMessage, noteKey)) {
    decisionNotification = await deliverSupportDecisionRequest({
      ticket,
      reason,
    });
    nextMessage = appendSupportReplyLog(
      nextMessage,
      buildSupportAutomationNoteEntry({
        recordedAt: new Date().toISOString(),
        automationRunId: runId,
        idempotencyKey: noteKey,
        status: 'decision_required',
        note: [
          reason,
          '',
          `経営判断通知: sent${decisionNotification.resendId ? ` / Resend ID: ${decisionNotification.resendId}` : ''}`,
          `通知先: ${decisionNotification.recipients.join(', ')}`,
        ].join('\n'),
      })
    );
  }

  const { data, error } = await client
    .from('support_tickets')
    .update({
      message: nextMessage,
      status: 'in_progress',
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticketId)
    .eq('updated_at', ticket.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return NextResponse.json(
      { error: 'Ticket changed while placing it on hold' },
      { status: 409 }
    );
  }

  return NextResponse.json({
    success: true,
    decision_required: true,
    decision_notification: decisionNotification
      ? {
          sent: true,
          resend_id: decisionNotification.resendId,
          recipients: decisionNotification.recipients,
        }
      : {
          sent: true,
          already_sent: true,
        },
    ticket: data,
  });
}

async function recordBusinessDecision(
  client: SupabaseClient,
  ticketId: string,
  runId: string,
  body: Record<string, unknown>
) {
  const ticket = await getTicket(client, ticketId);
  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    return NextResponse.json(
      { error: `Ticket is already ${ticket.status}` },
      { status: 409 }
    );
  }
  const decision = toSafeText(body.decision, 2000);
  if (!decision) {
    return NextResponse.json(
      { error: 'decision is required' },
      { status: 400 }
    );
  }

  const decisionState = getSupportDecisionState(
    ticket.message || '',
    ticketId
  );
  if (!decisionState.requested) {
    return NextResponse.json(
      { error: 'This ticket is not waiting for a business decision' },
      { status: 409 }
    );
  }
  if (decisionState.provided) {
    return NextResponse.json({
      success: true,
      decision_recorded: true,
      already_recorded: true,
      ticket,
    });
  }

  const nextMessage = appendSupportReplyLog(
    ticket.message || '',
    buildSupportAutomationNoteEntry({
      recordedAt: new Date().toISOString(),
      automationRunId: runId,
      idempotencyKey: `decision-response-${ticketId}`,
      status: 'decision_provided',
      note: decision,
    })
  );
  const { data, error } = await client
    .from('support_tickets')
    .update({
      message: nextMessage,
      status: 'open',
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticketId)
    .eq('updated_at', ticket.updated_at)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return NextResponse.json(
      { error: 'Ticket changed while recording the business decision' },
      { status: 409 }
    );
  }

  return NextResponse.json({
    success: true,
    decision_recorded: true,
    ticket: data,
  });
}

async function replyToTicket(
  client: SupabaseClient,
  ticketId: string,
  runId: string,
  body: Record<string, unknown>
) {
  const ticket = await getTicket(client, ticketId);
  const requestedIdempotencyKey =
    typeof body.idempotency_key === 'string'
      ? body.idempotency_key.trim()
      : '';
  const duplicateReply =
    requestedIdempotencyKey.length > 0 &&
    hasSupportReplyIdempotencyKey(
      ticket.message || '',
      requestedIdempotencyKey
    );
  if (!duplicateReply) {
    const ownershipError = validateClaimOwnership(ticket, runId);
    if (ownershipError) {
      return NextResponse.json({ error: ownershipError }, { status: 409 });
    }
  }
  const parsedMessage = splitSupportMessage(ticket.message || '');
  const policy = evaluateSupportAutomationPolicy({
    category: ticket.category,
    subject: ticket.subject,
    message: buildSupportCustomerPolicyMessage(parsedMessage),
  });
  const decisionState = getSupportDecisionState(
    ticket.message || '',
    ticket.id
  );
  const classification = toSafeText(
    body.classification,
    40
  ) as SupportAutomationClassification;
  const resolutionKind = toSafeText(
    body.resolution_kind,
    40
  ) as SupportAutomationResolutionKind;

  if (
    !SUPPORT_AUTOMATION_CLASSIFICATIONS.has(classification) ||
    !SUPPORT_AUTOMATION_RESOLUTION_KINDS.has(resolutionKind)
  ) {
    return NextResponse.json(
      { error: 'Invalid classification or resolution_kind' },
      { status: 400 }
    );
  }

  if (
    !canAutomationSendCustomerReply({
      classification,
      policyDecisionRequired: policy.decisionRequired,
      decisionProvided: decisionState.provided,
    })
  ) {
    return NextResponse.json(
      {
        error: 'This ticket requires a business decision',
        decision_required: true,
        reasons: policy.reasons,
      },
      { status: 409 }
    );
  }

  const evidence =
    body.evidence && typeof body.evidence === 'object'
      ? (body.evidence as Record<string, unknown>)
      : null;
  const evidenceError = validateSupportResolutionEvidence({
    resolutionKind,
    evidence,
  });
  if (evidenceError) {
    return NextResponse.json({ error: evidenceError }, { status: 409 });
  }
  if (resolutionKind === 'technical_fix') {
    const releaseEvidenceError = await verifyTechnicalReleaseEvidence(
      client,
      evidence || {}
    );
    if (releaseEvidenceError) {
      return NextResponse.json(
        { error: releaseEvidenceError },
        { status: 409 }
      );
    }
  }
  if (resolutionKind === 'account_fix') {
    const accountEvidenceError = await verifyAccountResolution(client, ticket);
    if (accountEvidenceError) {
      return NextResponse.json(
        { error: accountEvidenceError },
        { status: 409 }
      );
    }
  }

  const subject =
    typeof body.subject === 'string' ? body.subject.trim() : '';
  const message =
    typeof body.message === 'string' ? body.message.trim() : '';
  const idempotencyKey = toSafeText(body.idempotency_key, 180);
  const idempotencyKeyError = validateSupportReplyIdempotencyKey(
    ticketId,
    idempotencyKey
  );
  if (
    !subject ||
    !message ||
    subject.length > 200 ||
    message.length > 12_000
  ) {
    return NextResponse.json(
      {
        error:
          'subject (max 200), message (max 12000), and a valid idempotency_key are required',
      },
      { status: 400 }
    );
  }
  if (idempotencyKeyError) {
    return NextResponse.json({ error: idempotencyKeyError }, { status: 400 });
  }
  const replyClaimError = validateSupportReplyClaims({
    resolutionKind,
    message,
  });
  if (replyClaimError) {
    return NextResponse.json({ error: replyClaimError }, { status: 409 });
  }

  if (
    ticket.status !== 'in_progress' &&
    !hasSupportReplyIdempotencyKey(ticket.message || '', idempotencyKey)
  ) {
    return NextResponse.json(
      { error: 'Ticket must be claimed before replying' },
      { status: 409 }
    );
  }

  const statusOnSuccess =
    resolutionKind === 'progress' ? 'in_progress' : 'resolved';
  const result = await deliverSupportReply({
    adminClient: client,
    ticketId,
    subject,
    message,
    senderLabel: 'ACTI自動サポート',
    idempotencyKey,
    statusOnSuccess,
    automationRunId: runId,
    evidence: buildEvidenceSummary(resolutionKind, evidence),
  });

  return NextResponse.json(result, { status: result.success ? 200 : 502 });
}

async function enrichTicketContext(
  client: SupabaseClient,
  ticket: SupportTicket
) {
  const parsed = splitSupportMessage(ticket.message || '');
  const policy = evaluateSupportAutomationPolicy({
    category: ticket.category,
    subject: ticket.subject,
    message: buildSupportCustomerPolicyMessage(parsed),
  });
  const decision = getSupportDecisionState(ticket.message || '', ticket.id);

  let profileQuery = client
    .from('profiles')
    .select(
      'id,email,display_name,role,is_active,subscription_status,subscribed_at,cancelled_at,paid_test_credits,awakes_access_started_at,awakes_access_expires_at,awakes_access_source,chat_count_month,chat_month_start'
    )
    .limit(1);
  profileQuery = ticket.user_id
    ? profileQuery.eq('id', ticket.user_id)
    : profileQuery.ilike('email', ticket.email);
  const { data: profiles, error: profileError } = await profileQuery;
  if (profileError) throw profileError;
  const profile = profiles?.[0] || null;

  let sessions: Record<string, unknown>[] = [];
  if (profile?.id) {
    const { data, error } = await client
      .from('chat_sessions')
      .select(
        'id,diagnosis_result_id,title,created_at,updated_at,last_message_at,message_count'
      )
      .eq('user_id', profile.id)
      .order('last_message_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    sessions = data || [];
  }

  let reportedSessionMessages: Record<string, unknown>[] = [];
  const reportedSessionId = parsed.technicalContext?.sessionId;
  if (
    reportedSessionId &&
    sessions.some((session) => session.id === reportedSessionId)
  ) {
    const { data, error } = await client
      .from('chat_messages')
      .select('id,role,content,created_at')
      .eq('session_id', reportedSessionId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    reportedSessionMessages = (data || []).reverse();
  }

  return {
    id: ticket.id,
    user_id: ticket.user_id,
    name: ticket.name,
    email: ticket.email,
    category: ticket.category,
    subject: ticket.subject,
    customer_message: parsed.customerMessage,
    technical_context: parsed.technicalContext,
    support_history: parsed.replyLog,
    status: ticket.status,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    policy,
    decision,
    profile,
    recent_sessions: sessions,
    reported_session_messages: reportedSessionMessages,
  };
}

async function enrichQualityIncidentContext(
  client: SupabaseClient,
  incident: CoachingQualityIncident
) {
  const [profileResult, sessionResult, messagesResult] = await Promise.all([
    client
      .from('profiles')
      .select('id,email,display_name,subscription_status,is_active')
      .eq('id', incident.user_id)
      .maybeSingle(),
    client
      .from('chat_sessions')
      .select('id,title,created_at,updated_at,last_message_at,message_count')
      .eq('id', incident.session_id)
      .maybeSingle(),
    client
      .from('chat_messages')
      .select('id,role,content,created_at')
      .eq('session_id', incident.session_id)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(24),
  ]);
  if (profileResult.error) throw profileResult.error;
  if (sessionResult.error) throw sessionResult.error;
  if (messagesResult.error) throw messagesResult.error;

  return {
    ...incident,
    profile: profileResult.data || null,
    session: sessionResult.data || null,
    recent_messages: (messagesResult.data || []).reverse(),
  };
}

async function getTicket(client: SupabaseClient, ticketId: string) {
  const { data, error } = await client
    .from('support_tickets')
    .select('*')
    .eq('id', ticketId)
    .single<SupportTicket>();
  if (error || !data) throw new Error('Ticket not found');
  return data;
}

async function getQualityIncident(
  client: SupabaseClient,
  incidentId: string
) {
  const { data, error } = await client
    .from('coaching_quality_incidents')
    .select('*')
    .eq('id', incidentId)
    .single<CoachingQualityIncident>();
  if (error || !data) throw new Error('Quality incident not found');
  return data;
}

function validateAutomationAuthorization(request: NextRequest) {
  const expectedSecret = process.env.SUPPORT_AUTOMATION_SECRET || '';
  if (!expectedSecret) return 'Support automation secret is not configured';

  const authHeader = request.headers.get('authorization') || '';
  const providedSecret = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : '';
  const expected = Buffer.from(expectedSecret);
  const provided = Buffer.from(providedSecret);
  if (
    expected.length === provided.length &&
    timingSafeEqual(expected, provided)
  ) {
    return '';
  }
  return 'Unauthorized';
}

function toSafeText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function buildSupportCustomerPolicyMessage(
  parsed: ReturnType<typeof splitSupportMessage>
) {
  return [
    parsed.customerMessage,
    ...extractSupportInboundCustomerMessages(parsed.replyLog),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function validateClaimOwnership(ticket: SupportTicket, runId: string) {
  if (ticket.status !== 'in_progress') {
    return 'Ticket must be claimed before this action';
  }

  return getLatestSupportAutomationClaimRunId(ticket.message || '') === runId
    ? ''
    : 'Ticket is owned by another automation run';
}

function validateQualityIncidentOwnership(
  incident: CoachingQualityIncident,
  runId: string
) {
  if (incident.status !== 'in_progress') {
    return 'Quality incident must be claimed before this action';
  }
  return incident.claimed_run_id === runId
    ? ''
    : 'Quality incident is owned by another automation run';
}

function buildEvidenceSummary(
  resolutionKind: SupportAutomationResolutionKind,
  evidence: Record<string, unknown> | null
) {
  if (!evidence) return `対応種別: ${resolutionKind}`;

  return [
    `対応種別: ${resolutionKind}`,
    evidence.productionCommit
      ? `本番SHA: ${String(evidence.productionCommit)}`
      : null,
    evidence.productionDeploymentId
      ? `デプロイ: ${String(evidence.productionDeploymentId)}`
      : null,
    Number.isFinite(Number(evidence.monitorSuccesses))
      ? `監視成功: ${Number(evidence.monitorSuccesses)}回`
      : null,
    Number.isFinite(Number(evidence.observationMinutes))
      ? `観測: ${Number(evidence.observationMinutes)}分`
      : null,
  ]
    .filter(Boolean)
    .join(' / ');
}

async function verifyTechnicalReleaseEvidence(
  client: SupabaseClient,
  evidence: Record<string, unknown>
) {
  const productionCommit = String(evidence.productionCommit || '');
  const productionDeploymentId = String(
    evidence.productionDeploymentId || ''
  );
  const { data, error } = await client
    .from('coaching_monitor_runs')
    .select(
      'status,checked_at,deployment_commit,deployment_id,http_status,completion_status,finalization_status,error'
    )
    .order('checked_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  const successfulStreak = [];
  for (const run of data || []) {
    const healthy =
      run.status === 'success' &&
      run.deployment_commit === productionCommit &&
      run.deployment_id === productionDeploymentId &&
      run.http_status === 200 &&
      run.completion_status === 'complete' &&
      run.finalization_status === 'complete' &&
      !run.error;
    if (!healthy) break;
    successfulStreak.push(run);
  }

  const newestAt = new Date(successfulStreak[0]?.checked_at || 0).getTime();
  const oldestAt = new Date(
    successfulStreak[successfulStreak.length - 1]?.checked_at || 0
  ).getTime();
  if (
    successfulStreak.length < 3 ||
    newestAt - oldestAt < 20 * 60 * 1000
  ) {
    return '本番DBで20分以上の連続監視成功を確認できません';
  }

  const githubResponse = await fetchWithRetry(
    'https://api.github.com/repos/sanrinawakes/act-diagnosis-site/commits/main',
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'acti-support-automation',
      },
      cache: 'no-store',
    },
    2,
    10_000
  );
  if (!githubResponse.ok) {
    return 'GitHub mainの本番コミットを確認できません';
  }
  const mainCommit = (await githubResponse.json()) as { sha?: string };
  if (mainCommit.sha !== productionCommit) {
    return 'GitHub mainと本番監視のコミットが一致しません';
  }

  const regressionCheckVerified = await hasSuccessfulGitHubRegressionCheck(
    productionCommit
  );
  if (!regressionCheckVerified) {
    return '必須CIの成功を確認できません';
  }

  return '';
}

async function hasSuccessfulGitHubRegressionCheck(commitSha: string) {
  try {
    const checksResponse = await fetchWithRetry(
      `https://api.github.com/repos/sanrinawakes/act-diagnosis-site/commits/${commitSha}/check-runs`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'acti-support-automation',
        },
        cache: 'no-store',
      },
      2,
      10_000
    );
    if (checksResponse.ok) {
      const checks = (await checksResponse.json()) as {
        check_runs?: Array<{
          name?: string;
          status?: string;
          conclusion?: string | null;
        }>;
      };
      const regressionCheck = checks.check_runs?.find((check) =>
        /unit-and-build|coaching regression/i.test(check.name || '')
      );
      if (
        regressionCheck?.status === 'completed' &&
        regressionCheck.conclusion === 'success'
      ) {
        return true;
      }
    }
  } catch (error) {
    console.warn('GitHub check-runs lookup failed; falling back to checks page', {
      commitSha,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const htmlResponse = await fetchWithRetry(
      `https://github.com/sanrinawakes/act-diagnosis-site/commit/${commitSha}/checks`,
      {
        headers: {
          'User-Agent': 'acti-support-automation',
        },
        cache: 'no-store',
      },
      2,
      10_000
    );
    if (!htmlResponse.ok) {
      return false;
    }
    const html = await htmlResponse.text();
    return htmlShowsSuccessfulRegressionCheck(html);
  } catch (error) {
    console.warn('GitHub checks HTML lookup failed', {
      commitSha,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function htmlShowsSuccessfulRegressionCheck(html: string) {
  const match = html.match(
    /unit-and-build[\s\S]{0,5000}(?:data-job-status="completed"[\s\S]{0,5000}data-conclusion="success"|favicon-success\.svg)/i
  );
  return Boolean(match);
}

async function fetchWithRetry(
  input: string,
  init: RequestInit,
  attempts: number,
  timeoutMs: number
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('fetch failed');
}

async function verifyAccountResolution(
  client: SupabaseClient,
  ticket: SupportTicket
) {
  let query = client
    .from('profiles')
    .select('id,is_active,subscription_status,paid_test_credits,awakes_access_expires_at,role')
    .limit(1);
  query = ticket.user_id
    ? query.eq('id', ticket.user_id)
    : query.ilike('email', ticket.email);
  const { data, error } = await query;
  if (error) throw error;

  const profile = data?.[0];
  const hasAccess = hasCoachingAccess(profile);
  return hasAccess
    ? ''
    : '本番profilesで利用権限の復旧を確認できません';
}

function getCreatedAfter(requestedValue: string | null) {
  const configuredValue =
    requestedValue ||
    process.env.SUPPORT_AUTOMATION_START_AT ||
    DEFAULT_AUTOMATION_START_AT;
  const timestamp = new Date(configuredValue).getTime();
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : DEFAULT_AUTOMATION_START_AT;
}
