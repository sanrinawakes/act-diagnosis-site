import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: '認証されていません' }, { status: 401 });
    }
    const token = authHeader.replace('Bearer ', '');

    const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: 'Bearer ' + token } },
    });
    const { data: { user }, error: userError } = await userSupabase.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: '認証されていません' }, { status: 401 });
    }

    const body = await request.json();
    const awakesEmail = (body.email || '').toString().trim().toLowerCase();
    if (!awakesEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(awakesEmail)) {
      return NextResponse.json({ error: '有効なメールアドレスを入力してください' }, { status: 400 });
    }

    const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: pa } = await admin
      .from('pending_activations')
      .select('email, activated, source')
      .ilike('email', awakesEmail)
      .maybeSingle();

    if (!pa) {
      return NextResponse.json({
        error: 'このメールアドレスはAWAKESの決済記録に見つかりませんでした。AWAKESで決済時に使った正しいメールアドレスをご確認ください。',
      }, { status: 404 });
    }

    const { error: updateError } = await admin
      .from('profiles')
      .update({
        subscription_status: 'active',
        is_active: true,
        subscribed_at: new Date().toISOString(),
        myasp_customer_email: awakesEmail,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Profile update error:', updateError);
      return NextResponse.json({ error: 'プロファイル更新に失敗しました' }, { status: 500 });
    }

    await admin
      .from('pending_activations')
      .update({ activated: true, activated_at: new Date().toISOString() })
      .ilike('email', awakesEmail);

    return NextResponse.json({
      success: true,
      message: 'サブスクリプションを紐付けました。有料機能が使えるようになります。ページを更新してください。',
    });
  } catch (err) {
    console.error('Claim subscription error:', err);
    return NextResponse.json({ error: '予期しないエラーが発生しました' }, { status: 500 });
  }
}
