import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const exportSecret = process.env.MYASP_WEBHOOK_SECRET || '';

export async function GET(request: NextRequest) {
  if (!exportSecret || request.headers.get('x-export-secret') !== exportSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id, created_at, updated_at, status, category, name, email, subject, message')
    .in('status', ['open', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Support export error:', error);
    return NextResponse.json({ error: 'Failed to fetch support tickets' }, { status: 500 });
  }

  return NextResponse.json({ tickets: data || [] });
}
