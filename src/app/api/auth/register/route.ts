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

function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function validatePassword(password: string) {
  return password.length >= 8;
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('[AUTH/REGISTER] Missing Supabase server env vars');
      return NextResponse.json(
        { error: 'サーバー設定エラーです。時間をおいて再度お試しください。' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const email = normalizeEmail(body.email);
    const password = normalizeText(body.password);
    const displayName = normalizeText(body.displayName);

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json(
        { error: '有効なメールアドレスを入力してください。' },
        { status: 400 }
      );
    }

    if (!validatePassword(password)) {
      return NextResponse.json(
        { error: 'パスワードは8文字以上で入力してください。' },
        { status: 400 }
      );
    }

    const admin = createAdminClient();

    const { data: existingProfile, error: profileLookupError } = await admin
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .maybeSingle();

    if (profileLookupError) {
      console.error('[AUTH/REGISTER] Profile lookup failed:', profileLookupError);
      return NextResponse.json(
        { error: '登録状況の確認に失敗しました。時間をおいて再度お試しください。' },
        { status: 500 }
      );
    }

    if (existingProfile) {
      return NextResponse.json(
        {
          error:
            'このメールアドレスは既に登録されています。ログイン画面からお試しください。',
        },
        { status: 409 }
      );
    }

    const { data: newUser, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          display_name: displayName,
          source: 'self_register',
        },
      });

    if (createError) {
      const message = createError.message || '';
      if (
        /already been registered|already registered|already exists/i.test(
          message
        )
      ) {
        return NextResponse.json(
          {
            error:
              'このメールアドレスは既に登録されています。ログイン画面からお試しください。',
          },
          { status: 409 }
        );
      }

      console.error('[AUTH/REGISTER] User creation failed:', createError);
      return NextResponse.json(
        { error: 'アカウントを作成できませんでした。時間をおいて再度お試しください。' },
        { status: 500 }
      );
    }

    if (!newUser.user) {
      return NextResponse.json(
        { error: 'アカウントを作成できませんでした。時間をおいて再度お試しください。' },
        { status: 500 }
      );
    }

    if (displayName) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { error: updateError } = await admin
        .from('profiles')
        .update({
          display_name: displayName,
          updated_at: new Date().toISOString(),
        })
        .eq('id', newUser.user.id);

      if (updateError) {
        console.error('[AUTH/REGISTER] Profile update failed:', updateError);
      }
    }

    return NextResponse.json({
      success: true,
      message:
        'アカウントを作成しました。確認メールを待たずに、ログイン画面からログインできます。',
    });
  } catch (error) {
    console.error('[AUTH/REGISTER] Unexpected error:', error);
    return NextResponse.json(
      { error: '登録に失敗しました。時間をおいて再度お試しください。' },
      { status: 500 }
    );
  }
}
