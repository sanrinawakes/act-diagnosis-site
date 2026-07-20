import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { loadCoachingNoticeSettings } from '@/lib/coaching-notice-storage';

export const dynamic = 'force-dynamic';

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

export async function GET() {
  try {
    const settings = await loadCoachingNoticeSettings(createAdminClient());
    return NextResponse.json(settings, {
      status: 200,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    console.error('GET /api/coaching-notice error:', error);
    return NextResponse.json(
      { error: 'お知らせを取得できませんでした' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  }
}
