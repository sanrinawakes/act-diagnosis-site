import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AUDIT_CONFIRMATION = 'audit-four-users-20260616';
const TARGET_EMAILS = [
  'yun.yun3629@gmail.com',
  'mayumayu.k.6.11@gmail.com',
  'blue.moon.0052@gmail.com',
  'jlyb0331@gmail.com',
  'phantommasumi@gmail.com',
];

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function listTargetAuthUsers(adminClient: ReturnType<typeof createAdminClient>) {
  const users = [];
  let page = 1;

  while (page <= 10) {
    const { data, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage: 1000,
    });

    if (error) {
      throw error;
    }

    users.push(
      ...data.users
        .filter((user) => user.email && TARGET_EMAILS.includes(user.email.toLowerCase()))
        .map((user) => ({
          id: user.id,
          email: user.email,
          created_at: user.created_at,
          confirmed_at: user.confirmed_at,
          email_confirmed_at: user.email_confirmed_at,
          last_sign_in_at: user.last_sign_in_at,
          providers: user.app_metadata?.providers || [],
        }))
    );

    if (data.users.length < 1000) {
      break;
    }

    page++;
  }

  return users;
}

export async function POST(request: NextRequest) {
  try {
    const auditSecret = request.headers.get('x-audit-secret');
    const auditConfirmation = request.headers.get('x-audit-confirmation');

    if (!process.env.MYASP_WEBHOOK_SECRET || auditSecret !== process.env.MYASP_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (auditConfirmation !== AUDIT_CONFIRMATION) {
      return NextResponse.json({ error: 'Confirmation header mismatch' }, { status: 400 });
    }

    const adminClient = createAdminClient();
    const authUsers = await listTargetAuthUsers(adminClient);

    const { data: profiles, error: profilesError } = await adminClient
      .from('profiles')
      .select('*')
      .in('email', TARGET_EMAILS)
      .order('email', { ascending: true });

    if (profilesError) {
      throw profilesError;
    }

    const { data: pendingActivations, error: pendingError } = await adminClient
      .from('pending_activations')
      .select('*')
      .in('email', TARGET_EMAILS)
      .order('email', { ascending: true });

    if (pendingError) {
      throw pendingError;
    }

    const { data: supportTickets, error: ticketsError } = await adminClient
      .from('support_tickets')
      .select('*')
      .in('email', TARGET_EMAILS)
      .order('created_at', { ascending: false });

    if (ticketsError) {
      throw ticketsError;
    }

    const profileIds = (profiles || []).map((profile) => profile.id);
    const { data: chatSessions, error: sessionsError } = profileIds.length
      ? await adminClient
          .from('chat_sessions')
          .select('id, user_id, title, created_at, updated_at, last_message_at, message_count')
          .in('user_id', profileIds)
          .order('last_message_at', { ascending: false })
          .limit(100)
      : { data: [], error: null };

    if (sessionsError) {
      throw sessionsError;
    }

    const sessionIds = (chatSessions || []).map((session) => session.id);
    const { data: recentMessages, error: messagesError } = sessionIds.length
      ? await adminClient
          .from('chat_messages')
          .select('id, session_id, role, content, created_at')
          .in('session_id', sessionIds)
          .order('created_at', { ascending: false })
          .limit(120)
      : { data: [], error: null };

    if (messagesError) {
      throw messagesError;
    }

    return NextResponse.json({
      auditedAt: new Date().toISOString(),
      targetEmails: TARGET_EMAILS,
      authUsers,
      profiles,
      pendingActivations,
      supportTickets,
      chatSessions,
      recentMessages,
    });
  } catch (error) {
    console.error('Four-user audit failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
