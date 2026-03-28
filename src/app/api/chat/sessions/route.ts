import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
    const search = url.searchParams.get('search');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

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
      `
      )
      .eq('user_id', user.id);

    // Apply pinned filter
    if (pinned) {
      sessionsQuery = sessionsQuery.eq('is_pinned', true);
    }

    // Apply search filter if provided
    let sessionIds: string[] | null = null;
    if (search) {
      const { data: searchResults, error: searchError } = await supabase
        .from('chat_messages')
        .select('session_id')
        .eq('user_id', user.id)
        .ilike('content', `%${search}%`);

      if (!searchError && searchResults) {
        const uniqueIds = Array.from(
          new Set(searchResults.map((r) => r.session_id))
        );
        sessionIds = uniqueIds;
        if (uniqueIds.length === 0) {
          return NextResponse.json({
            sessions: [],
            total: 0,
            page,
            limit,
          });
        }
        sessionsQuery = sessionsQuery.in('id', uniqueIds);
      }
    }

    // Order: pinned first, then by last_message_at descending
    sessionsQuery = sessionsQuery.order('is_pinned', { ascending: false })
      .order('last_message_at', { ascending: false, nullsFirst: false });

    const { data: sessions, error: sessionsError } = await sessionsQuery;

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

    // For unpinned sessions, only keep the latest 100, and delete older ones
    const pinnedSessions = sessions.filter((s) => s.is_pinned);
    const unpinnedSessions = sessions.filter((s) => !s.is_pinned);

    if (unpinnedSessions.length > 100) {
      const sessionsToDelete = unpinnedSessions.slice(100);
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

      // Delete old unpinned sessions (cascade will delete messages)
      await supabaseAdmin
        .from('chat_sessions')
        .delete()
        .in(
          'id',
          sessionsToDelete.map((s) => s.id)
        );

      // Keep only the latest 100 unpinned sessions
      sessions.splice(
        sessions.indexOf(sessionsToDelete[0]),
        sessionsToDelete.length
      );
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

    // Apply pagination
    const total = sessionsWithPreviews.length;
    const offset = (page - 1) * limit;
    const paginatedSessions = sessionsWithPreviews.slice(
      offset,
      offset + limit
    );

    return NextResponse.json({
      sessions: paginatedSessions,
      total,
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

    const body = await request.json();
    const { session_id, is_pinned, title } = body;

    if (!session_id) {
      return NextResponse.json(
        { error: 'session_id is required' },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Verify session belongs to user
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('user_id')
      .eq('id', session_id)
      .single();

    if (sessionError || !session || session.user_id !== user.id) {
      return NextResponse.json(
        { error: 'Session not found or unauthorized' },
        { status: 404 }
      );
    }

    // If pinning, check if user already has 100 pinned sessions
    if (is_pinned === true) {
      const { data: pinnedSessions, error: pinnedError } = await supabase
        .from('chat_sessions')
        .select('id', { count: 'exact' })
        .eq('user_id', user.id)
        .eq('is_pinned', true);

      if (pinnedError) throw pinnedError;

      if (pinnedSessions && pinnedSessions.length >= 100) {
        return NextResponse.json(
          { error: 'Maximum 100 pinned sessions allowed' },
          { status: 400 }
        );
      }
    }

    const updateData: Record<string, any> = {};
    if (is_pinned !== undefined) {
      updateData.is_pinned = is_pinned;
    }
    if (title !== undefined) {
      updateData.title = title;
    }

    const { data: updatedSession, error: updateError } = await supabase
      .from('chat_sessions')
      .update(updateData)
      .eq('id', session_id)
      .select()
      .single();

    if (updateError) throw updateError;

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

    const body = await request.json();
    const { session_id } = body;

    if (!session_id) {
      return NextResponse.json(
        { error: 'session_id is required' },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Verify session belongs to user
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('user_id')
      .eq('id', session_id)
      .single();

    if (sessionError || !session || session.user_id !== user.id) {
      return NextResponse.json(
        { error: 'Session not found or unauthorized' },
        { status: 404 }
      );
    }

    // Delete session (cascade will delete messages)
    const { error: deleteError } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', session_id);

    if (deleteError) throw deleteError;

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
