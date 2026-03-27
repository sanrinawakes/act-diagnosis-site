import { NextRequest, NextResponse } from 'next/server';

// GET handler - redirect to login page
export async function GET() {
  return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_SUPABASE_URL ? 'https://act-diagnosis-site.vercel.app' : 'http://localhost:3000'));
}

export async function POST(request: NextRequest) {
  const baseUrl = request.nextUrl.origin;

  try {
    const contentType = request.headers.get('content-type') || '';
    let email = '';
    let password = '';
    let redirect = '/dashboard';

    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      // Native HTML form submission
      const formData = await request.formData();
      email = formData.get('email') as string || '';
      password = formData.get('password') as string || '';
      redirect = formData.get('redirect') as string || '/dashboard';
    } else {
      // JSON request
      const body = await request.json();
      email = body.email || '';
      password = body.password || '';
      redirect = body.redirect || '/dashboard';
    }

    if (!email || !password) {
      const loginUrl = new URL('/login', baseUrl);
      loginUrl.searchParams.set('error', 'メールアドレスとパスワードを入力してください');
      return NextResponse.redirect(loginUrl, { status: 303 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('[AUTH/LOGIN] Missing Supabase env vars');
      const loginUrl = new URL('/login', baseUrl);
      loginUrl.searchParams.set('error', 'サーバー設定エラー');
      return NextResponse.redirect(loginUrl, { status: 303 });
    }

    // Use Supabase REST API directly to sign in
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ email, password }),
    });

    const authData = await authResponse.json();

    if (!authResponse.ok || authData.error) {
      console.error('[AUTH/LOGIN] Auth failed:', authData.error || authData.error_description);
      const loginUrl = new URL('/login', baseUrl);
      loginUrl.searchParams.set('error', 'メールアドレスまたはパスワードが正しくありません');
      return NextResponse.redirect(loginUrl, { status: 303 });
    }

    // Set Supabase auth cookies
    const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
    const cookieName = `sb-${projectRef}-auth-token`;
    const cookieValue = JSON.stringify({
      access_token: authData.access_token,
      refresh_token: authData.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + authData.expires_in,
      expires_in: authData.expires_in,
      token_type: authData.token_type,
      user: authData.user,
    });

    const redirectUrl = new URL(redirect, baseUrl).toString();

    // Return an HTML page that sets the cookie and redirects client-side.
    // This avoids timing issues with 303 redirect + Set-Cookie where the
    // middleware may not see the cookie on the redirected request.
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>ログイン中...</title></head>
<body>
<p>ログイン中...</p>
<script>
document.cookie = ${JSON.stringify(`${cookieName}=${encodeURIComponent(cookieValue)};path=/;max-age=${authData.expires_in};secure;samesite=lax`)};
window.location.replace(${JSON.stringify(redirectUrl)});
</script>
<noscript><meta http-equiv="refresh" content="0;url=${redirectUrl}"></noscript>
</body>
</html>`;

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  } catch (error) {
    console.error('[AUTH/LOGIN] Error:', error);
    const loginUrl = new URL('/login', baseUrl);
    loginUrl.searchParams.set('error', 'ログインに失敗しました');
    return NextResponse.redirect(loginUrl, { status: 303 });
  }
}
