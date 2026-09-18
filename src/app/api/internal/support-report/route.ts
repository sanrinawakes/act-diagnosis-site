import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { reportAuthorized, reportWindow, redactSupportReportMessage, supportAutomationStartAt } from '@/lib/support-report-access';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function GET(request: NextRequest) {
  if (!reportAuthorized(request.headers.get('authorization'), process.env.SUPPORT_REPORT_READ_SECRET)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const window = reportWindow(request.nextUrl.searchParams.get('since'), request.nextUrl.searchParams.get('until'));
  if (!window) return NextResponse.json({ error: 'Invalid report window' }, { status: 400 });
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const automationStartAt = supportAutomationStartAt(process.env.SUPPORT_AUTOMATION_START_AT);
  // Fixed tables, fixed columns and SELECT only. The report key cannot claim, reply, update or delete.
  async function read(table: 'support_tickets' | 'coaching_quality_incidents' | 'coaching_monitor_runs', columns: string, clock: string, open = false) {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 10000; offset += 250) {
      let query = db.from(table).select(columns).order(clock).order('id').range(offset, offset + 249);
      if (open && table === 'support_tickets') query = query.in('status', ['open', 'in_progress']).gte('created_at', automationStartAt);
      else query = open ? query.not('status', 'in', '(resolved,closed)') : query.gte(clock, window!.since).lt(clock, window!.until);
      const { data, error } = await query;
      if (error) throw new Error('report_read_failed');
      const batch = (data || []) as unknown as Record<string, unknown>[];
      if (table === 'support_tickets') for (const row of batch) row.message = redactSupportReportMessage(row.message);
      rows.push(...batch); if (batch.length < 250) return rows;
    }
    throw new Error('report_limit_exceeded');
  }
  async function readLegacyOpenCount() {
    const { count, error } = await db.from('support_tickets')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'in_progress'])
      .lt('created_at', automationStartAt);
    if (error || count === null) throw new Error('report_read_failed');
    return count;
  }
  try {
    const [tickets, openTickets, incidents, openIncidents, monitors, legacyOpenCount] = await Promise.all([
      read('support_tickets', 'id,subject,status,category,created_at,updated_at,message', 'updated_at'),
      read('support_tickets', 'id,subject,status,category,created_at,updated_at,message', 'updated_at', true),
      read('coaching_quality_incidents', 'id,issue,status,updated_at,resolution_kind', 'updated_at'),
      read('coaching_quality_incidents', 'id,issue,status,updated_at,resolution_kind', 'updated_at', true),
      read('coaching_monitor_runs', 'id,status,created_at,http_status,completion_status,finalization_status', 'created_at'),
      readLegacyOpenCount(),
    ]);
    return NextResponse.json({ window, automationStartAt, legacyOpenCount, tickets, openTickets, incidents, openIncidents, monitors }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Report unavailable' }, { status: 503 });
  }
}
