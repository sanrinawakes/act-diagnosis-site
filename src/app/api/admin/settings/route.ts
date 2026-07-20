import { createClient as createServerClient } from '@supabase/supabase-js';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { SiteSettings } from '@/lib/types';
import {
  parseSiteSettingsPatch,
  validateEnabledCoachingNotice,
  type EditableSiteSettings,
} from '@/lib/site-settings';
import {
  loadCoachingNoticeSettings,
  saveCoachingNoticeSettings,
} from '@/lib/coaching-notice-storage';

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

// GET: Get current site settings
export async function GET(request: NextRequest) {
  try {
    // Verify admin role
    const userId = await verifyAdminRole(request);
    if (!userId) {
      return NextResponse.json({ error: '管理者権限が必要です' }, { status: 403 });
    }

    const adminClient = createAdminClient();
    const noticeSettings = await loadCoachingNoticeSettings(adminClient);

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
        ...noticeSettings,
        updated_at: new Date().toISOString(),
        updated_by: null,
      };
      return NextResponse.json(defaultSettings, { status: 200 });
    }

    return NextResponse.json({ ...settings, ...noticeSettings }, { status: 200 });
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
    let settingsPatch: Partial<EditableSiteSettings>;

    try {
      settingsPatch = parseSiteSettingsPatch(body);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '設定内容が正しくありません' },
        { status: 400 }
      );
    }

    // Get the current values so an enabled notice can never be saved without text.
    const { data: existingSettings, error: existingSettingsError } = await adminClient
      .from('site_settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (existingSettingsError) {
      throw existingSettingsError;
    }

    const currentNoticeSettings = await loadCoachingNoticeSettings(adminClient);

    const currentEditableSettings: EditableSiteSettings = {
      bot_enabled: existingSettings?.bot_enabled ?? true,
      maintenance_mode: existingSettings?.maintenance_mode ?? false,
      ...currentNoticeSettings,
    };
    const nextEditableSettings = {
      ...currentEditableSettings,
      ...settingsPatch,
    };

    try {
      validateEnabledCoachingNotice(nextEditableSettings);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '告知内容が正しくありません' },
        { status: 400 }
      );
    }

    // Build update object
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: userId,
    };
    if (settingsPatch.bot_enabled !== undefined) {
      updateData.bot_enabled = settingsPatch.bot_enabled;
    }
    if (settingsPatch.maintenance_mode !== undefined) {
      updateData.maintenance_mode = settingsPatch.maintenance_mode;
    }

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
        .insert([
          {
            id: 1,
            bot_enabled: nextEditableSettings.bot_enabled,
            maintenance_mode: nextEditableSettings.maintenance_mode,
            ...updateData,
          },
        ])
        .select()
        .single());
    }

    if (error) {
      throw error;
    }

    await saveCoachingNoticeSettings(adminClient, {
      coaching_notice_enabled: nextEditableSettings.coaching_notice_enabled,
      coaching_notice_title: nextEditableSettings.coaching_notice_title,
      coaching_notice_body: nextEditableSettings.coaching_notice_body,
    });

    return NextResponse.json(
      {
        ...result,
        coaching_notice_enabled: nextEditableSettings.coaching_notice_enabled,
        coaching_notice_title: nextEditableSettings.coaching_notice_title,
        coaching_notice_body: nextEditableSettings.coaching_notice_body,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('PATCH /api/admin/settings error:', error);
    return NextResponse.json(
      { error: '設定の保存に失敗しました' },
      { status: 500 }
    );
  }
}
