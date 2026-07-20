import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@/lib/supabase-server';
import type {
  CoachingScopeCategory,
  CoachingScopeDecision,
} from '@/lib/coaching-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const VALID_DECISIONS = new Set<CoachingScopeDecision>([
  'allowed',
  'blocked',
]);
const VALID_CATEGORIES = new Set<CoachingScopeCategory>([
  'coaching',
  'conversation_followup',
  'writing_editing',
  'marketing_content',
  'translation',
  'external_research',
  'image_generation',
  'programming',
  'ambiguous',
]);

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        { error: 'ログインが必要です' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || profile?.role !== 'admin') {
      return NextResponse.json(
        { error: '管理者権限が必要です' },
        { status: 403 }
      );
    }

    const serviceClient = createServiceClient();
    const params = request.nextUrl.searchParams;
    const userPage = parsePage(params.get('userPage'));
    const userLimit = parseLimit(params.get('userLimit'));
    const eventPage = parsePage(params.get('eventPage'));
    const eventLimit = parseLimit(params.get('eventLimit') || '50');
    const search = sanitizeSearch(params.get('search') || '');
    const decision = parseDecision(params.get('decision'));
    const category = parseCategory(params.get('category'));

    const overviewPromise = loadOverview(serviceClient);

    let userQuery = serviceClient
      .from('coaching_usage_by_user')
      .select('*', { count: 'exact' });
    if (search) {
      userQuery = userQuery.or(
        `email.ilike.%${search}%,display_name.ilike.%${search}%`
      );
    }

    const userOffset = (userPage - 1) * userLimit;
    const userSummaryPromise = userQuery
      .order('last_request_at', { ascending: false })
      .range(userOffset, userOffset + userLimit - 1);

    let matchingUserIds: string[] | null = null;
    if (search) {
      const { data: matchedProfiles, error: matchedProfilesError } =
        await serviceClient
          .from('profiles')
          .select('id')
          .or(`email.ilike.%${search}%,display_name.ilike.%${search}%`)
          .limit(500);
      if (matchedProfilesError) throw matchedProfilesError;
      matchingUserIds = (matchedProfiles || []).map((item) => item.id);
    }

    let events: Array<Record<string, unknown>> = [];
    let eventCount = 0;
    if (!matchingUserIds || matchingUserIds.length > 0) {
      let eventQuery = serviceClient
        .from('coaching_usage_events')
        .select(
          'id, request_id, user_id, session_id, decision, category, matched_rule, message_chars, total_request_chars, line_count, is_long_message, attachment_count, provider_requested, created_at',
          { count: 'exact' }
        );
      if (matchingUserIds) eventQuery = eventQuery.in('user_id', matchingUserIds);
      if (decision) eventQuery = eventQuery.eq('decision', decision);
      if (category) eventQuery = eventQuery.eq('category', category);

      const eventOffset = (eventPage - 1) * eventLimit;
      const eventResult = await eventQuery
        .order('created_at', { ascending: false })
        .range(eventOffset, eventOffset + eventLimit - 1);
      if (eventResult.error) throw eventResult.error;
      events = (eventResult.data || []) as Array<Record<string, unknown>>;
      eventCount = eventResult.count || 0;
    }

    const eventUserIds = Array.from(
      new Set(events.map((event) => String(event.user_id)))
    );
    const profileMap = new Map<
      string,
      { email: string; displayName: string | null }
    >();
    if (eventUserIds.length > 0) {
      const { data: eventProfiles, error: eventProfilesError } =
        await serviceClient
          .from('profiles')
          .select('id, email, display_name')
          .in('id', eventUserIds);
      if (eventProfilesError) throw eventProfilesError;
      (eventProfiles || []).forEach((item) => {
        profileMap.set(item.id, {
          email: item.email,
          displayName: item.display_name,
        });
      });
    }

    const [overview, userSummaryResult] = await Promise.all([
      overviewPromise,
      userSummaryPromise,
    ]);
    if (userSummaryResult.error) throw userSummaryResult.error;

    const response = NextResponse.json({
      overview,
      users: (userSummaryResult.data || []).map(normalizeUserSummary),
      userPagination: {
        page: userPage,
        limit: userLimit,
        total: userSummaryResult.count || 0,
        totalPages: Math.max(
          1,
          Math.ceil((userSummaryResult.count || 0) / userLimit)
        ),
      },
      events: events.map((event) => ({
        ...event,
        email: profileMap.get(String(event.user_id))?.email || '',
        displayName:
          profileMap.get(String(event.user_id))?.displayName || null,
      })),
      eventPagination: {
        page: eventPage,
        limit: eventLimit,
        total: eventCount,
        totalPages: Math.max(1, Math.ceil(eventCount / eventLimit)),
      },
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    console.error('GET /api/admin/coaching-usage error:', error);
    return NextResponse.json(
      { error: 'AI利用監査データの取得に失敗しました' },
      { status: 500 }
    );
  }
}

function createServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase service configuration');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadOverview(serviceClient: SupabaseClient) {
  const { data, error } = await serviceClient
    .from('coaching_usage_overview')
    .select(
      'total_requests, blocked_requests, long_message_requests, unique_users'
    )
    .single();
  if (error) throw error;

  return {
    totalRequests: Number(data?.total_requests || 0),
    blockedRequests: Number(data?.blocked_requests || 0),
    longMessageRequests: Number(data?.long_message_requests || 0),
    uniqueUsers: Number(data?.unique_users || 0),
  };
}

function normalizeUserSummary(item: Record<string, unknown>) {
  return {
    userId: String(item.user_id || ''),
    email: String(item.email || ''),
    displayName:
      typeof item.display_name === 'string' ? item.display_name : null,
    totalRequests: Number(item.total_requests || 0),
    allowedRequests: Number(item.allowed_requests || 0),
    blockedRequests: Number(item.blocked_requests || 0),
    longMessageRequests: Number(item.long_message_requests || 0),
    attachmentRequests: Number(item.attachment_requests || 0),
    lastRequestAt: String(item.last_request_at || ''),
    lastBlockedAt:
      typeof item.last_blocked_at === 'string' ? item.last_blocked_at : null,
  };
}

function parsePage(value: string | null) {
  const parsed = Number.parseInt(value || '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseLimit(value: string | null) {
  const parsed = Number.parseInt(value || String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function sanitizeSearch(value: string) {
  return value
    .trim()
    .slice(0, 100)
    .replace(/[^\w@.+\-\u3040-\u30ff\u3400-\u9fff\s]/g, '');
}

function parseDecision(value: string | null): CoachingScopeDecision | null {
  return value && VALID_DECISIONS.has(value as CoachingScopeDecision)
    ? (value as CoachingScopeDecision)
    : null;
}

function parseCategory(value: string | null): CoachingScopeCategory | null {
  return value && VALID_CATEGORIES.has(value as CoachingScopeCategory)
    ? (value as CoachingScopeCategory)
    : null;
}
