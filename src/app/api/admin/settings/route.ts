import { createClient as createServerClient } from '@supabase/supabase-js';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { SiteSettings } from '@/lib/types';

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
async function verifyAdminRole(request: NextRequest): Promise<string | null> {
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
        setAll(cookiesToSet) {
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

// GET: Get current site settings
export async function GET(request: NextRequest) {
  try {
    // Verify admin role
    const userId = await verifyAdminRole(request);
    if (!userId) {
      return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
    }

    const adminClient = createAdminClient();

    // Fetch site settings
    const { data: settings, error } = await adminClient
      .from('site_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    // Return default settings if none exist
    if (!settings) {
      const defaultSettings: SiteSettings = {
        id: 1,
        bot_enabled: true,
        maintenance_mode: false,
        updated_at: new Date().toISOString(),
        updated_by: null,
      };
      return NextResponse.json(defaultSettings, { status: 200 });
    }

    return NextResponse.json(settings, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/settings error:', error);
    return NextResponse.json(
      { error: '設定の取得に失敗しました' },
      { status: 500 }
    );
  }
}

// PATCH: Update site settings
export async function PATCH(request: NextRequest) {
  try {
    // Verify admin role
    const userId = await verifyAdminRole(request);
    if (!userId) {
      return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
    }

    const adminClient = createAdminClient();
    const body = await request.json();
    const { bot_enabled, maintenance_mode } = body;

    // Build update object
    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
      updated_by: userId,
    };

    if (bot_enabled !== undefined) {
      updateData.bot_enabled = bot_enabled;
    }
    if (maintenance_mode !== undefined) {
      updateData.maintenance_mode = maintenance_mode;
    }

    // First, try to get existing settings
    const { data: existingSettings } = await adminClient
      .from('site_settings')
      .select('id')
      .limit(1)
      .single();

    let result;
    let error;

    if (existingSettings) {
      // Update existing settings
      ({ data: result, error } = await adminClient
        .from('site_settings')
        .update(updateData)
        .eq('id', existingSettings.id)
        .select()
        .single());
    } else {
      // Insert new settings
      ({ data: result, error } = await adminClient
        .from('site_settings')
        .insert([{ id: 1, bot_enabled: true, maintenance_mode: false, ...updateData }])
        .select()
        .single());
    }

    if (error) {
      throw error;
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/settings error:', error);
    return NextResponse.json(
      { error: '設定の保存に失敗しました' },
      { status: 500 }
    );
  }
}
