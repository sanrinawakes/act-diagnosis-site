'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const { t } = useI18n();

  // URLパラメータからエラーを読み取り、既存セッションがあればリダイレクト
  useEffect(() => {
    const urlError = searchParams.get('error');
    if (urlError) {
      setError(urlError);
      return;
    }

    const checkExistingSession = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const redirect = searchParams.get('redirect') || '/dashboard';
        router.push(redirect);
      }
    };
    checkExistingSession();
  }, [searchParams, supabase, router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    // パスワードマネージャー等によるautofill対策: DOM値も取得
    let loginEmail = email;
    let loginPassword = password;
    if (!loginEmail || !loginPassword) {
      const emailInput = document.getElementById('email') as HTMLInputElement;
      const passwordInput = document.getElementById('password') as HTMLInputElement;
      if (emailInput?.value) loginEmail = emailInput.value;
      if (passwordInput?.value) loginPassword = passwordInput.value;
    }

    if (!loginEmail || !loginPassword) {
      setError('メールアドレスとパスワードを入力してください');
      return;
    }

    setError('');
    setIsLoading(true);

    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });

      if (authError) {
        if (authError.message.includes('Invalid login credentials')) {
          setError(t('login.error.invalid'));
        } else {
          setError(authError.message);
        }
        return;
      }

      const redirect = searchParams.get('redirect') || '/dashboard';
      router.push(redirect);
      router.refresh();
    } catch {
      setError(t('login.error.failed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSocialLogin = async (provider: 'google' | 'kakao') => {
    setSocialLoading(provider);
    setError('');

    try {
      const redirectTo = `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(searchParams.get('redirect') || '/dashboard')}`;

      // LINEの場合はカスタムOIDCプロバイダーとして'kakao'のスロットを使う
      // ※ Supabaseの設定でLINEをカスタムOIDCとして登録する場合の対応
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
        },
      });

      if (oauthError) {
        setError(oauthError.message);
        setSocialLoading(null);
      }
      // リダイレクトされるのでsocialLoadingのリセットは不要
    } catch {
      setError('ソーシャルログインに失敗しました');
      setSocialLoading(null);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-blue-100 via-blue-50 to-blue-100">
      <div className="w-full max-w-md">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl p-8 border border-blue-200/60 shadow-xl">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('login.title')}</h1>
            <p className="text-gray-600">{t('login.welcome')}</p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-100 border border-red-400 rounded-lg">
              <p className="text-red-700 text-sm">{error}</p>
            </div>
          )}

          {/* Social Login Buttons */}
          <div className="space-y-3 mb-6">
            <button
              type="button"
              onClick={() => handleSocialLogin('google')}
              disabled={!!socialLoading}
              className="w-full flex items-center justify-center gap-3 py-3 px-4 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
            >
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              <span className="text-gray-700 font-medium">
                {socialLoading === 'google' ? '接続中...' : 'Googleでログイン'}
              </span>
            </button>

            {/* LINE Login - SupabaseでカスタムOIDCプロバイダーとして設定後に有効化 */}
            {/*
            <button
              type="button"
              onClick={() => handleSocialLogin('kakao')}
              disabled={!!socialLoading}
              className="w-full flex items-center justify-center gap-3 py-3 px-4 bg-[#06C755] border border-[#06C755] rounded-lg hover:bg-[#05b54d] disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/>
              </svg>
              <span className="text-white font-medium">
                {socialLoading === 'kakao' ? '接続中...' : 'LINEでログイン'}
              </span>
            </button>
            */}
          </div>

          {/* Divider */}
          <div className="mb-6 flex items-center gap-4">
            <div className="flex-1 h-px bg-blue-200"></div>
            <span className="text-gray-500 text-sm">または</span>
            <div className="flex-1 h-px bg-blue-200"></div>
          </div>

          {/* Form - action/method provide native HTML fallback if React JS fails */}
          <form action="/api/auth/login" method="POST" onSubmit={handleLogin} className="space-y-5">
            <input type="hidden" name="redirect" value={searchParams.get('redirect') || '/dashboard'} />
            {/* Email Field */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                {t('login.email')}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
                className="w-full px-4 py-3 bg-white border border-blue-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent transition-all"
              />
            </div>

            {/* Password Field */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                {t('login.password')}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
                className="w-full px-4 py-3 bg-white border border-blue-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent transition-all"
              />
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors duration-200 mt-6"
            >
              {isLoading ? t('login.loading') : t('login.submit')}
            </button>
          </form>

          {/* Register Link */}
          <div className="mt-6">
            <p className="text-center text-gray-600">
              {t('login.noAccount')}
              <Link href="/register" className="text-blue-500 hover:text-blue-600 font-semibold ml-1">
                {t('login.register')}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
