import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { hasValidWebhookSecret } from '@/lib/webhook-auth';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MEMBER_IMPORT_SECRET = process.env.MEMBER_IMPORT_SECRET || '';
const MAX_IMPORT_EMAILS = 500;

function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Admin API: Import existing MyASP member emails into pending_activations
 *
 * POST /api/admin/import-members
 * Body (JSON):
 *   - secret: dedicated member-import secret
 *   - members: list of verified MyASP memberships with a start date and cycle
 *
 * This allows bulk reconciliation of verified MyASP membership terms. Existing
 * legacy ACTI profiles are updated; unlinked emails remain pending until the
 * separate one-time verification-code flow is completed.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!MEMBER_IMPORT_SECRET) {
      console.error('Member import is not configured');
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }

    // Do not reuse the public payment webhook secret for an administrative bulk action.
    if (!hasValidWebhookSecret(MEMBER_IMPORT_SECRET, body.secret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const members: unknown[] = body.members;
    if (!Array.isArray(members) || members.length === 0) {
      return NextResponse.json(
        { error: 'members array is required and must not be empty' },
        { status: 400 }
      );
    }
    if (members.length > MAX_IMPORT_EMAILS) {
      return NextResponse.json(
        { error: `members must contain at most ${MAX_IMPORT_EMAILS} records` },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();
    const results = {
      imported: 0,
      blocked: 0,
      skipped: 0,
      errors: 0,
    };

    const importedEmails = new Set<string>();
    for (const rawMember of members) {
      const member = readMember(rawMember);
      if (!member) {
        results.skipped++;
        continue;
      }
      const { email } = member;
      if (importedEmails.has(email)) {
        results.skipped++;
        continue;
      }
      importedEmails.add(email);

      try {
        const { data, error: upsertError } = await adminClient.rpc(
          'apply_awakes_membership_event',
          {
            p_email: email,
            p_event_type: 'legacy_import',
            p_external_event_id: member.eventId,
            p_occurred_at: member.startedAt,
            p_renewal_cycle: member.renewalCycle,
            p_source: 'myasp_import',
          }
        );

        if (upsertError) {
          // If unique constraint violation, it's already there - that's OK
          if (!upsertError.message.includes('duplicate')) {
            console.error('Member import activation upsert failed', {
              error: upsertError.message,
            });
            results.errors++;
            continue;
          }
        }

        const eventResult = Array.isArray(data) ? data[0] : data;
        if (eventResult?.status === 'account_not_eligible') {
          results.blocked++;
          continue;
        }

        results.imported++;
      } catch (err) {
        console.error('Member import item failed', {
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        results.errors++;
      }
    }

    return NextResponse.json({
      success: true,
      results,
      message: `Imported ${results.imported} pending entitlements, skipped ${results.skipped}`,
    });
  } catch (error) {
    console.error('Import members error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function readMember(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
  const startedAt = typeof record.started_at === 'string' ? record.started_at.trim() : '';
  const eventId = typeof record.event_id === 'string' ? record.event_id.trim() : '';
  const renewalCycle = Number(record.renewal_cycle ?? 0);
  const parsedStart = Date.parse(startedAt);
  if (
    !email.includes('@') ||
    !Number.isFinite(parsedStart) ||
    parsedStart > Date.now() + 24 * 60 * 60 * 1000 ||
    !eventId ||
    eventId.length > 200 ||
    !Number.isInteger(renewalCycle) ||
    renewalCycle < 0 ||
    renewalCycle > 100
  ) {
    return null;
  }
  return {
    email,
    startedAt: new Date(parsedStart).toISOString(),
    eventId,
    renewalCycle,
  };
}
