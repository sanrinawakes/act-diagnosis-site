import { NextRequest, NextResponse } from 'next/server';

// Password login is handled by the Supabase browser client on /login. Keeping a
// second server route that writes browser-readable auth tokens duplicates the
// authentication flow and widens the token exposure surface.
export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/login', request.nextUrl.origin));
}

export async function POST(request: NextRequest) {
  return NextResponse.json(
    {
      error:
        'ログイン画面からメールアドレスとパスワードを入力してください。',
    },
    { status: 405, headers: { Allow: 'GET' } }
  );
}
