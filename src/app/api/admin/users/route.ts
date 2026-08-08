import { createClient as createServerClient } from '@supabase/supabase-js';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { hasAllowedRequestOrigin } from '@/lib/request-origin';

const PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 100;

// Helper to create admin Supabase client with service role key
function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createServerClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

// Helper to check if user is admin
async function verifyAdminRole(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return null;
    }

    const ssrClient = createSSRClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignore server component errors
          }
        },
      },
    });

    const {
      data: { user },
    } = await ssrClient.auth.getUser();

    if (!user) {
      return null;
    }

    // Check if user is admin
    const { data: profile, error } = await ssrClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (error || !profile || profile.role !== 'admin') {
      return null;
    }

    return user.id;
  } catch (error) {
    console.error('Admin verification failed:', error);
    return null;
  }
}

// GET: List all profiles with pagination and search
export async function GET(request: NextRequest) {
  try {
    // Verify admin role
    const userId = await verifyAdminRole();
    if (!userId) {
      return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
    }

    const adminClient = createAdminClient();

    // Get search and pagination params
    const searchParams = request.nextUrl.searchParams;
    const search = (searchParams.get('search') || '').trim().slice(0, 100);
    const page = parsePositiveInt(searchParams.get('page'), 1, 10_000);
    const limit = parsePositiveInt(searchParams.get('limit'), 20, MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    // Build query
    let query = adminClient.from('profiles').select('*');

    // Apply search filter
    if (search) {
      query = query.ilike('email', `%${search}%`);
    }

    let countQuery = adminClient
      .from('profiles')
      .select('*', { count: 'exact', head: true });
    if (search) {
      countQuery = countQuery.ilike('email', `%${search}%`);
    }

    const { count: totalCount, error: countError } = await countQuery;
    if (countError) {
      throw countError;
    }

    // Get paginated results
    const { data: profiles, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    return NextResponse.json(
      {
        data: profiles || [],
        pagination: {
          page,
          limit,
          total: totalCount || 0,
          totalPages: Math.ceil((totalCount || 0) / limit),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('GET /api/admin/users error:', error);
    return NextResponse.json(
      { error: 'ユーザー一覧の取得に失敗しました' },
      { status: 500 }
    );
  }
}

// PATCH: Update user (is_active or role)
export async function PATCH(request: NextRequest) {
  try {
    if (!hasAllowedRequestOrigin(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // Verify admin role
    const userId = await verifyAdminRole();
    if (!userId) {
      return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
    }

    const adminClient = createAdminClient();
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return NextResponse.json({ error: '更新内容が正しくありません' }, { status: 400 });
    }
    const { user_id, is_active, role } = body;

    if (typeof user_id !== 'string' || !PROFILE_ID_PATTERN.test(user_id)) {
      return NextResponse.json({ error: 'user_idが必要です' }, { status: 400 });
    }

    // Build update object
    const updateData: Record<string, boolean | string> = {};
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') {
        return NextResponse.json({ error: 'is_activeは真偽値で指定してください' }, { status: 400 });
      }
      updateData.is_active = is_active;
    }
    if (role !== undefined) {
      if (role !== 'admin' && role !== 'member') {
        return NextResponse.json({ error: '無効な役割です' }, { status: 400 });
      }
      updateData.role = role;
    }
    if (body.subscription_status !== undefined) {
      const validStatuses = ['none', 'active', 'cancelled', 'payment_failed'];
      if (
        typeof body.subscription_status !== 'string' ||
        !validStatuses.includes(body.subscription_status)
      ) {
        return NextResponse.json({ error: '無効な会員ステータスです' }, { status: 400 });
      }
      updateData.subscription_status = body.subscription_status;
      // activeに変更する場合はsubscribed_atも設定
      if (body.subscription_status === 'active') {
        updateData.subscribed_at = new Date().toISOString();
        updateData.is_active = true;
      }
      // cancelled に変更する場合は cancelled_at を設定
      if (body.subscription_status === 'cancelled') {
        updateData.cancelled_at = new Date().toISOString();
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: '更新するフィールドが指定されていません' },
        { status: 400 }
      );
    }

    // Update profile
    const { data: updatedProfile, error } = await adminClient
      .from('profiles')
      .update(updateData)
      .eq('id', user_id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(updatedProfile, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/users error:', error);
    return NextResponse.json(
      { error: 'ユーザーの更新に失敗しました' },
      { status: 500 }
    );
  }
}

function parsePositiveInt(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
