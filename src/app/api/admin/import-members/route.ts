import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  canActivatePendingProfile,
  hasValidWebhookSecret,
} from '@/lib/webhook-auth';

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
 *   - emails: string[] - list of email addresses to import
 *
 * This allows bulk importing existing MyASP members so they get auto-activated
 * when they create an account on the ACT diagnosis site.
 *
 * Also checks if any of these emails already have profiles, and activates them.
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

    const emails: string[] = body.emails;
    if (!Array.isArray(emails) || emails.length === 0) {
      return NextResponse.json(
        { error: 'emails array is required and must not be empty' },
        { status: 400 }
      );
    }
    if (emails.length > MAX_IMPORT_EMAILS || emails.some((email) => typeof email !== 'string')) {
      return NextResponse.json(
        { error: `emails must contain at most ${MAX_IMPORT_EMAILS} email addresses` },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();
    const results = {
      imported: 0,
      skipped: 0,
      activated_existing: 0,
      errors: 0,
    };

    for (const rawEmail of new Set(emails)) {
      const email = rawEmail.trim().toLowerCase();
      if (!email || !email.includes('@')) {
        results.skipped++;
        continue;
      }

      try {
        // Upsert into pending_activations
        const { error: upsertError } = await adminClient
          .from('pending_activations')
          .upsert(
            {
              email,
              source: 'myasp_import',
              activated: false,
              created_at: new Date().toISOString(),
            },
            { onConflict: 'email' }
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

        results.imported++;

        // Check if this email already has a profile, and activate if needed
        const { data: existingProfile } = await adminClient
          .from('profiles')
          .select('id, email, subscription_status')
          .eq('email', email)
          .single();

        if (
          existingProfile &&
          canActivatePendingProfile(existingProfile.subscription_status)
        ) {
          const { error: updateError } = await adminClient
            .from('profiles')
            .update({
              subscription_status: 'active',
              is_active: true,
              myasp_customer_email: email,
              subscribed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingProfile.id);

          if (!updateError) {
            results.activated_existing++;

            // Mark as activated in pending_activations
            await adminClient
              .from('pending_activations')
              .update({ activated: true, activated_at: new Date().toISOString() })
              .eq('email', email);
          }
        }
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
      message: `Imported ${results.imported} emails, activated ${results.activated_existing} existing profiles, skipped ${results.skipped}`,
    });
  } catch (error) {
    console.error('Import members error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
