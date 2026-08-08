import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getJapanDateKey } from '@/lib/japan-date';
import { createServerClient } from '@/lib/supabase-server';
import { hasAllowedRequestOrigin } from '@/lib/request-origin';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

interface RequestBody {
  email: string;
  answers: number[];
  level: number;
  typeCode?: string;
}

export async function POST(request: NextRequest) {
  try {
    if (!hasAllowedRequestOrigin(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body: RequestBody = await request.json();
    const { email, answers, level, typeCode } = body;

    const authClient = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError || !user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const requestedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedEmail = user.email.trim().toLowerCase();
    if (requestedEmail && requestedEmail !== normalizedEmail) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (
      !Array.isArray(answers) ||
      answers.length !== 15 ||
      !answers.every((answer) => Number.isInteger(answer) && answer >= -2 && answer <= 2) ||
      !Number.isInteger(level) ||
      level < 1 ||
      level > 2 ||
      (typeCode !== undefined && (typeof typeCode !== 'string' || !/^[SMP][VMG][AME]$/.test(typeCode)))
    ) {
      return NextResponse.json(
        { error: '診断内容が正しくありません。最初からやり直してください。' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Check if free user already exists
    const { data: existingUser, error: selectError } = await supabase
      .from('free_users')
      .select('id')
      .eq('email', normalizedEmail)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (selectError) {
      console.error('Error checking for existing user:', selectError);
      return NextResponse.json(
        { error: 'Database error' },
        { status: 500 }
      );
    }

    const now = new Date().toISOString();

    if (existingUser) {
      // Update existing user
      const { error: updateError } = await supabase
        .from('free_users')
        .update({
          diagnosis_completed: true,
          diagnosis_level: level,
          diagnosis_type_code: typeCode || null,
          updated_at: now,
        })
        .eq('id', existingUser.id);

      if (updateError) {
        console.error('Error updating free user:', updateError);
        return NextResponse.json(
          { error: 'Failed to update diagnosis' },
          { status: 500 }
        );
      }
    } else {
      // Create new free user
      const { error: insertError } = await supabase
        .from('free_users')
        .insert({
          email: normalizedEmail,
          diagnosis_completed: true,
          diagnosis_level: level,
          diagnosis_type_code: typeCode || null,
          chat_count_today: 0,
          last_chat_date: getJapanDateKey(),
          created_at: now,
          updated_at: now,
        });

      if (insertError) {
        console.error('Error creating free user:', insertError);
        return NextResponse.json(
          { error: 'Failed to save diagnosis' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Diagnosis saved successfully',
    });
  } catch (error) {
    console.error('Free diagnosis API error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: '診断結果を保存できませんでした。時間をおいて、もう一度お試しください。' },
      { status: 500 }
    );
  }
}
