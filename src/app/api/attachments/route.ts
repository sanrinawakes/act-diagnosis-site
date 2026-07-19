import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { uploadImageAttachments } from '@/lib/server-attachments';
import { createServerClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return NextResponse.json(
        { error: 'Supabase configuration is missing' },
        { status: 500 }
      );
    }

    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.replace('Bearer ', '')
      : '';
    const supabase = token
      ? createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        })
      : await createServerClient();

    let authResult;
    try {
      authResult = await withTimeout(
        token ? supabase.auth.getUser(token) : supabase.auth.getUser(),
        8000
      );
    } catch {
      return NextResponse.json(
        {
          error:
            'ログイン状態の確認に時間がかかりました。画面を再読み込みして、もう一度お試しください。',
        },
        { status: 504 }
      );
    }
    const {
      data: { user },
      error: userError,
    } = authResult;

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const purpose = formData.get('purpose') === 'support' ? 'support' : 'chat';
    const files = formData
      .getAll('attachments')
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    const dateFolder = new Date().toISOString().slice(0, 10);

    const attachments = await uploadImageAttachments({
      files,
      folder: `${purpose}/${user.id}/${dateFolder}`,
      supabaseUrl,
      serviceRoleKey,
    });

    return NextResponse.json({
      success: true,
      attachments,
    });
  } catch (error) {
    console.error('POST /api/attachments error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : '画像のアップロードに失敗しました。',
      },
      { status: 500 }
    );
  }
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('AUTH_TIMEOUT')), timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
    clearTimeout(timeoutId)
  );
}
