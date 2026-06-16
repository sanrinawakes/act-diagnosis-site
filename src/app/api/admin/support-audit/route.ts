import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const auditSecret = process.env.MYASP_WEBHOOK_SECRET || '';

const ticketEmails = [
  'a.oogoda@gmail.com',
  'sakusakubloom.9@gmail.com',
  'kumu1875k@gmail.com',
  'yusaku.h.1107@gmail.com',
  'phantommasumi@gmail.com',
  'akihiro.aizawa.s.491001.a.a@gmail.com',
  'peachflower87@gmail.com',
  'kykorenotaan1321@gmail.com',
  'kouki.takikawa@gmail.com',
  'm.ranchan.015067a8k@gmail.com',
  '9stmidori@gmail.com',
  'yamarika.0320@gmail.com',
  'shanti726@gmail.com',
];

export async function GET(request: NextRequest) {
  if (!auditSecret || request.headers.get('x-audit-secret') !== auditSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select(
      'id, email, display_name, role, is_active, subscription_status, paid_test_credits, myasp_customer_email, subscribed_at, cancelled_at, created_at, updated_at'
    )
    .in('email', ticketEmails);

  if (profilesError) {
    console.error('Support audit profiles error:', profilesError);
    return NextResponse.json({ error: 'Failed to fetch profiles' }, { status: 500 });
  }

  const { data: pendingActivations, error: pendingError } = await supabase
    .from('pending_activations')
    .select('email, source, activated, activated_at, created_at')
    .in('email', ticketEmails)
    .order('created_at', { ascending: false });

  if (pendingError) {
    console.error('Support audit pending error:', pendingError);
    return NextResponse.json({ error: 'Failed to fetch pending activations' }, { status: 500 });
  }

  const profileIds = (profiles || []).map((profile) => profile.id);
  const { data: chatSessions, error: sessionsError } = await supabase
    .from('chat_sessions')
    .select('id, user_id, title, created_at, updated_at, last_message_at, message_count')
    .in('user_id', profileIds)
    .order('last_message_at', { ascending: false })
    .limit(500);

  if (sessionsError) {
    console.error('Support audit sessions error:', sessionsError);
    return NextResponse.json({ error: 'Failed to fetch chat sessions' }, { status: 500 });
  }

  return NextResponse.json({
    profiles: profiles || [],
    pending_activations: pendingActivations || [],
    chat_sessions: chatSessions || [],
  });
}
