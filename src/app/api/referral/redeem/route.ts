import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { hasAllowedRequestOrigin } from '@/lib/request-origin';

const VALID_CODES: Record<string, number> = {
  'DSA7H1': 1,
};

export async function POST(request: NextRequest) {
  try {
    if (!hasAllowedRequestOrigin(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const code = (body.code || '').trim().toUpperCase();

    if (!code || !VALID_CODES[code]) {
      return NextResponse.json(
        { error: '無効な紹介コードです' },
        { status: 400 }
      );
    }

    // Get authenticated user
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {},
        },
      }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json(
        { error: 'ログインが必要です' },
        { status: 401 }
      );
    }

    // Check if user already used a referral code
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const credits = VALID_CODES[code];
    const { data, error: redeemError } = await supabaseAdmin.rpc(
      'redeem_referral_code',
      {
        p_user_id: user.id,
        p_referral_code: code,
        p_credits: credits,
      }
    );
    if (redeemError) {
      console.error('Referral code redemption failed:', redeemError);
      return NextResponse.json(
        { error: '紹介コードの適用に失敗しました' },
        { status: 503 }
      );
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (result?.status === 'already_used') {
      return NextResponse.json(
        { error: '紹介コードは既に使用済みです' },
        { status: 400 }
      );
    }
    if (result?.status !== 'applied') {
      console.error('Referral code redemption returned an unexpected result');
      return NextResponse.json(
        { error: '紹介コードの適用に失敗しました' },
        { status: 503 }
      );
    }

    return NextResponse.json({
      success: true,
      credits_added: credits,
      message: `紹介コードが適用されました。有料テストを${credits}回受けることができます。`,
    });
  } catch (error) {
    console.error('Referral code error:', error);
    return NextResponse.json(
      { error: 'サーバーエラーが発生しました' },
      { status: 500 }
    );
  }
}
