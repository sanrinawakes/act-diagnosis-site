import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next') || '/dashboard';

  if (!code && !tokenHash) {
    return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent('認証コードが取得できませんでした'), origin));
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

  // Magic link / OTP flow (signInWithOtp emailRedirectTo)
  if (tokenHash) {
    const { error } = await supabase.auth.verifyOtp({
      type: (type as any) || 'email',
      token_hash: tokenHash,
    });
    if (error) {
      return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent('ログインリンクの検証に失敗しました: ' + error.message), origin));
    }
    return response;
  }

  // OAuth PKCE flow (Google / LINE)
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent('セッション取得に失敗しました: ' + error.message), origin));
    }
    return response;
  }

  return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent('予期しないエラー'), origin));
}
