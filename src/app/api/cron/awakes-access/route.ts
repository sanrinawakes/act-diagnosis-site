import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || '';
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('AWAKES expiry cron is not configured');
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc('expire_awakes_memberships');
  if (error) {
    console.error('AWAKES expiry cron failed:', error);
    const { error: failureAuditError } = await admin
      .from('awakes_access_cron_runs')
      .insert({ status: 'failed' });
    if (failureAuditError) {
      console.error('AWAKES expiry failure audit persistence failed:', failureAuditError);
    }
    return NextResponse.json({ error: 'Expiry processing failed' }, { status: 500 });
  }

  const result = Array.isArray(data) ? data[0] : data;
  const auditRow = {
    status: 'succeeded',
    memberships_expired: Number(result?.memberships_expired || 0),
    profiles_deactivated: Number(result?.profiles_deactivated || 0),
    pending_revoked: Number(result?.pending_revoked || 0),
  };
  const { data: savedRun, error: auditError } = await admin
    .from('awakes_access_cron_runs')
    .insert(auditRow)
    .select('id, created_at')
    .single();
  if (auditError || !savedRun) {
    console.error('AWAKES expiry cron audit persistence failed:', auditError);
    return NextResponse.json({ error: 'Expiry audit persistence failed' }, { status: 500 });
  }

  console.info(
    JSON.stringify({
      event: 'awakes_access_expiry_completed',
      runId: savedRun.id,
      membershipsExpired: auditRow.memberships_expired,
      profilesDeactivated: auditRow.profiles_deactivated,
      pendingRevoked: auditRow.pending_revoked,
    })
  );
  return NextResponse.json({ success: true, run_id: savedRun.id, ...result });
}
