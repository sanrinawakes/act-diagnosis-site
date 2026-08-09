import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function createAdminClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

export async function PATCH(request: NextRequest) {
  try {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const displayName =
      body && typeof body.display_name === 'string'
        ? body.display_name.trim()
        : null;

    if (displayName === null || displayName.length > 100) {
      return NextResponse.json(
        { error: '表示名は100文字以内で入力してください。' },
        { status: 400 }
      );
    }

    const authClient = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { error: updateError } = await createAdminClient()
      .from('profiles')
      .update({
        display_name: displayName || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('PATCH /api/profile update failed:', updateError);
      return NextResponse.json(
        { error: 'プロフィールを保存できませんでした。もう一度お試しください。' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, display_name: displayName || null });
  } catch (error) {
    console.error('PATCH /api/profile error:', error);
    return NextResponse.json(
      { error: 'プロフィールを保存できませんでした。もう一度お試しください。' },
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
