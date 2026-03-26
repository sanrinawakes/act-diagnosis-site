import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(request: NextRequest) {
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
      // Redirect back to login with error
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('error', 'メールアドレスとパスワードを入力してください');
      return NextResponse.redirect(loginUrl);
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

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
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('error', 'メールアドレスまたはパスワードが正しくありません');
      return NextResponse.redirect(loginUrl);
    }

    // Set Supabase auth cookies and redirect to dashboard
    const response = NextResponse.redirect(new URL(redirect, request.url));

    // Set the access token and refresh token as cookies
    // Supabase JS client reads these cookies to restore the session
    const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
    const cookieName = `sb-${projectRef}-auth-token`;

    response.cookies.set(cookieName, JSON.stringify({
      access_token: authData.access_token,
      refresh_token: authData.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + authData.expires_in,
      expires_in: authData.expires_in,
      token_type: authData.token_type,
      user: authData.user,
    }), {
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      maxAge: authData.expires_in,
    });

    return response;
  } catch (error) {
    console.error('[AUTH/LOGIN] Error:', error);
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('error', 'ログインに失敗しました');
    return NextResponse.redirect(loginUrl);
  }
}
