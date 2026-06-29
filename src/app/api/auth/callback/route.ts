import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { normalizeAuthRedirect, withAuthTimeout } from '@/lib/auth-flow';

function redirectToLogin(origin: string, error: string, next: string) {
  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('error', error);
  loginUrl.searchParams.set('redirect', next);
  return NextResponse.redirect(loginUrl);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const providerError = searchParams.get('error_description') || searchParams.get('error');
  const next = normalizeAuthRedirect(searchParams.get('next'));

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

  if (providerError) {
    return redirectToLogin(
      origin,
      `ログイン連携が完了しませんでした: ${providerError}`,
      next
    );
  }

  if (!code && !tokenHash) {
    try {
      const {
        data: { user },
      } = await withAuthTimeout(
        supabase.auth.getUser(),
        'ログイン状態の確認に時間がかかりすぎました。'
      );

      if (user) {
        return response;
      }
    } catch (error) {
      console.error('[AUTH/CALLBACK] Existing session check failed:', error);
    }

    return redirectToLogin(
      origin,
      'ログイン情報を確認できませんでした。お手数ですが、もう一度ログインしてください。',
      next
    );
  }

  // Magic link / OTP flow (signInWithOtp emailRedirectTo)
  if (tokenHash) {
    const { error } = await withAuthTimeout(
      supabase.auth.verifyOtp({
        type: (type as any) || 'email',
        token_hash: tokenHash,
      }),
      'ログインリンクの確認に時間がかかりすぎました。'
    );
    if (error) {
      return redirectToLogin(origin, 'ログインリンクの検証に失敗しました: ' + error.message, next);
    }
    return response;
  }

  // OAuth PKCE flow (Google / LINE)
  if (code) {
    const { error } = await withAuthTimeout(
      supabase.auth.exchangeCodeForSession(code),
      'ログイン連携の完了に時間がかかりすぎました。'
    );
    if (error) {
      return redirectToLogin(origin, 'セッション取得に失敗しました: ' + error.message, next);
    }
    return response;
  }

  return redirectToLogin(origin, '予期しないエラー', next);
}
