import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { uploadImageAttachments } from '@/lib/server-attachments';

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
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized: No token provided' },
        { status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

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
