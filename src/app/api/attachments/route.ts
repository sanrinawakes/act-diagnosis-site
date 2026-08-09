import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { uploadImageAttachments } from '@/lib/server-attachments';
import { createServerClient } from '@/lib/supabase-server';
import {
  ATTACHMENT_BUCKET,
  isSafeAttachmentPath,
  SIGNED_URL_EXPIRES_IN,
} from '@/lib/attachments';
import { hasAllowedRequestOrigin } from '@/lib/request-origin';

export const runtime = 'nodejs';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createAttachmentAdminClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const path = request.nextUrl.searchParams.get('path') || '';
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!isSafeAttachmentPath(path)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const authClient = await createServerClient();
    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminClient = createAttachmentAdminClient(supabaseUrl, serviceRoleKey);
    if (!(await canReadAttachment({ adminClient, userId: user.id, path }))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data, error } = await adminClient.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(path, SIGNED_URL_EXPIRES_IN);
    if (error || !data?.signedUrl) {
      console.error('Attachment signed URL creation failed:', error);
      return NextResponse.json({ error: '画像を開けませんでした。' }, { status: 503 });
    }

    const response = NextResponse.redirect(data.signedUrl, 302);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    console.error('GET /api/attachments error:', error);
    return NextResponse.json({ error: '画像を開けませんでした。' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return NextResponse.json(
        { error: '画像のアップロードを準備できませんでした。時間をおいて、もう一度お試しください。' },
        { status: 500 }
      );
    }

    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.replace('Bearer ', '')
      : '';
    if (!token && !hasAllowedRequestOrigin(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
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
      { error: '画像のアップロードに失敗しました。' },
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

async function canReadAttachment({
  adminClient,
  userId,
  path,
}: {
  adminClient: ReturnType<typeof createAttachmentAdminClient>;
  userId: string;
  path: string;
}) {
  const directPrefixes = [`chat/${userId}/`, `support/${userId}/`];
  if (directPrefixes.some((prefix) => path.startsWith(prefix))) return true;

  const ticketMatch = /^support\/([0-9a-f-]{36})\/inbound\//i.exec(path);
  if (ticketMatch && UUID_PATTERN.test(ticketMatch[1])) {
    const { data: ticket, error } = await adminClient
      .from('support_tickets')
      .select('user_id')
      .eq('id', ticketMatch[1])
      .maybeSingle();
    if (error) throw error;
    if (ticket?.user_id === userId) return true;
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw profileError;
  return profile?.role === 'admin';
}
