import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SessionWithPreview {
  id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  is_pinned: boolean;
  last_message_at: string | null;
  message_count: number;
  preview: string | null;
}

async function getUserFromToken(token: string) {
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return null;
  }

  return user;
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized: No token provided' },
        { status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const user = await getUserFromToken(token);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Get query parameters
    const url = new URL(request.url);
    const pinned = url.searchParams.get('pinned') === 'true';
    const search = url.searchParams.get('search')?.trim().slice(0, 200) || '';
    const requestedPage = parseInt(url.searchParams.get('page') || '1', 10);
    const requestedLimit = parseInt(url.searchParams.get('limit') || '20', 10);
    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit))
      : 20;

    let sessionsQuery = supabase
      .from('chat_sessions')
      .select(
        `
        id,
        user_id,
        title,
        created_at,
        updated_at,
        is_pinned,
        last_message_at,
        message_count
      `,
        { count: 'exact' }
      )
      .eq('user_id', user.id);

    // Apply pinned filter
    if (pinned) {
      sessionsQuery = sessionsQuery.eq('is_pinned', true);
    }

    // Apply search filter if provided
    if (search) {
      const { data: searchResults, error: searchError } = await supabase
        .from('chat_messages')
        .select('session_id')
        .ilike('content', `%${search}%`);

      if (searchError) throw searchError;
      const uniqueIds = Array.from(
        new Set((searchResults || []).map((result) => result.session_id))
      );
      if (uniqueIds.length === 0) {
        return NextResponse.json({ sessions: [], total: 0, page, limit });
      }
      sessionsQuery = sessionsQuery.in('id', uniqueIds);
    }

    // Order: pinned first, then by last_message_at descending
    sessionsQuery = sessionsQuery.order('is_pinned', { ascending: false })
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    const offset = (page - 1) * limit;
    sessionsQuery = sessionsQuery.range(offset, offset + limit - 1);

    const { data: sessions, count, error: sessionsError } = await sessionsQuery;

    if (sessionsError) {
      throw sessionsError;
    }

    if (!sessions) {
      return NextResponse.json({
        sessions: [],
        total: 0,
        page,
        limit,
      });
    }

    // Fetch first user message as preview for each session
    const sessionsWithPreviews: SessionWithPreview[] = await Promise.all(
      sessions.map(async (session) => {
        const { data: messages } = await supabase
          .from('chat_messages')
          .select('content')
          .eq('session_id', session.id)
          .eq('role', 'user')
          .order('created_at', { ascending: true })
          .limit(1);

        const preview =
          messages && messages.length > 0
            ? messages[0].content.substring(0, 50)
            : null;

        return {
          ...session,
          preview,
        };
      })
    );

    return NextResponse.json({
      sessions: sessionsWithPreviews,
      total: count || 0,
      page,
      limit,
    });
  } catch (error) {
    console.error('Sessions GET error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Internal server error',
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized: No token provided' },
        { status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const user = await getUserFromToken(token);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { session_id, is_pinned, title } = body;

    if (typeof session_id !== 'string' || !UUID_PATTERN.test(session_id)) {
      return NextResponse.json(
        { error: 'Valid session_id is required' },
        { status: 400 }
      );
    }

    if (is_pinned !== undefined && typeof is_pinned !== 'boolean') {
      return NextResponse.json({ error: 'is_pinned must be boolean' }, { status: 400 });
    }
    if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
      return NextResponse.json({ error: 'Invalid title' }, { status: 400 });
    }
    if (is_pinned === undefined && title === undefined) {
      return NextResponse.json({ error: 'No update provided' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    // If pinning, check if user already has 100 pinned sessions
    if (is_pinned === true) {
      const { count: pinnedCount, error: pinnedError } = await supabase
        .from('chat_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_pinned', true);

      if (pinnedError) throw pinnedError;

      if ((pinnedCount || 0) >= 100) {
        return NextResponse.json(
          { error: 'Maximum 100 pinned sessions allowed' },
          { status: 400 }
        );
      }
    }

    const updateData: { is_pinned?: boolean; title?: string } = {};
    if (is_pinned !== undefined) {
      updateData.is_pinned = is_pinned;
    }
    if (title !== undefined) {
      updateData.title = title;
    }

    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('chat_sessions')
      .update(updateData)
      .eq('id', session_id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;
    if (!updatedSession) {
      return NextResponse.json(
        { error: 'Session not found or unauthorized' },
        { status: 404 }
      );
    }

    return NextResponse.json(updatedSession);
  } catch (error) {
    console.error('Sessions PATCH error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Internal server error',
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized: No token provided' },
        { status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const user = await getUserFromToken(token);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { session_id } = body;

    if (typeof session_id !== 'string' || !UUID_PATTERN.test(session_id)) {
      return NextResponse.json(
        { error: 'Valid session_id is required' },
        { status: 400 }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    // Delete session (cascade will delete messages)
    const { data: deletedSession, error: deleteError } = await supabaseAdmin
      .from('chat_sessions')
      .delete()
      .eq('id', session_id)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle();

    if (deleteError) throw deleteError;
    if (!deletedSession) {
      return NextResponse.json(
        { error: 'Session not found or unauthorized' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Sessions DELETE error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
