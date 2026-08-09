import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { persistChatMessageRecord } from '@/lib/chat-message-persistence';
import { createServerClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PersistBody = {
  id?: unknown;
  sessionId?: unknown;
  role?: unknown;
  content?: unknown;
};

function createAdminClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

export async function POST(request: NextRequest) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as PersistBody | null;
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const role = body.role === 'user' ? body.role : '';
  const content = typeof body.content === 'string' ? body.content : '';

  if (
    !UUID_PATTERN.test(id) ||
    !UUID_PATTERN.test(sessionId) ||
    !role ||
    !content.trim()
  ) {
    return NextResponse.json(
      { error: 'Valid user message id, sessionId, and content are required' },
      { status: 400 }
    );
  }

  try {
    const authClient = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();
    const { data: session, error: sessionError } = await admin
      .from('chat_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (sessionError) {
      throw new Error(`CHAT_SESSION_LOOKUP_FAILED: ${sessionError.message}`);
    }
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    await persistChatMessageRecord({
      supabase: admin,
      id,
      sessionId,
      role,
      content,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST /api/chat/messages error:', error);
    return NextResponse.json(
      { error: 'メッセージを保存できませんでした。もう一度お試しください。' },
      { status: 500 }
    );
  }
}

function isAllowedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  const allowedOrigins = new Set([request.nextUrl.origin]);
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (configuredSiteUrl) {
    try {
      allowedOrigins.add(new URL(configuredSiteUrl).origin);
    } catch {
      // Ignore malformed optional configuration.
    }
  }

  return allowedOrigins.has(origin);
}
