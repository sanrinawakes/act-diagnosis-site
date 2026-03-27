import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') || '/dashboard';

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=認証コードが取得できませんでした', origin));
  }

  let response = NextResponse.redirect(new URL(next, origin));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options as any);
          });
        },
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('OAuth callback error:', error);
    return NextResponse.redirect(new URL('/login?error=ログインに失敗しました', origin));
  }

  // ソーシャルログインで新規ユーザーの場合、profilesレコードを確認・作成
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .single();

    if (!existingProfile) {
      // profilesにレコードがない場合、新規作成
      // Supabaseのトリガーで自動作成される場合もあるが、念のためフォールバック
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: user.id,
          email: user.email || '',
          display_name: user.user_metadata?.full_name || user.user_metadata?.name || '',
          role: 'member',
          is_active: true,
          subscription_status: 'free',
        });

      if (profileError) {
        console.error('Profile creation error:', profileError);
        // プロフィール作成失敗でもログイン自体は成功させる
      }
    }
  }

  return response;
}
