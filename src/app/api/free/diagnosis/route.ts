import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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
    const body: RequestBody = await request.json();
    const { email, answers, level, typeCode } = body;

    if (!email || answers === undefined || level === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: email, answers, level' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Check if free user already exists
    const { data: existingUser, error: selectError } = await supabase
      .from('free_users')
      .select('id')
      .eq('email', email)
      .single();

    if (selectError && selectError.code !== 'PGRST116') {
      // PGRST116 = no rows returned
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
          email,
          diagnosis_completed: true,
          diagnosis_level: level,
          diagnosis_type_code: typeCode || null,
          chat_count_today: 0,
          last_chat_date: new Date().toISOString().split('T')[0],
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
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
