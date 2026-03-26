import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MYASP_WEBHOOK_SECRET = process.env.MYASP_WEBHOOK_SECRET || '';

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
 *   - secret: admin secret (uses MYASP_WEBHOOK_SECRET)
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

    // Verify admin secret
    if (!MYASP_WEBHOOK_SECRET || body.secret !== MYASP_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const emails: string[] = body.emails;
    if (!Array.isArray(emails) || emails.length === 0) {
      return NextResponse.json(
        { error: 'emails array is required and must not be empty' },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();
    const results = {
      imported: 0,
      skipped: 0,
      activated_existing: 0,
      errors: [] as string[],
    };

    for (const rawEmail of emails) {
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
            results.errors.push(`${email}: ${upsertError.message}`);
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

        if (existingProfile && existingProfile.subscription_status !== 'active') {
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
        results.errors.push(`${email}: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
