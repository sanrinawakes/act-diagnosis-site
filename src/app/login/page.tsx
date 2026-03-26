'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const supabase = createClient();
  const { t } = useI18n();

  useEffect(() => {
    setHydrated(true);
    console.log('[LOGIN] Component hydrated successfully');
  }, []);

  const doLogin = async (loginEmail: string, loginPassword: string) => {
    console.log('[LOGIN] doLogin called with email:', loginEmail);
    setError('');
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });

      console.log('[LOGIN] Supabase response, error:', error);

      if (error) {
        if (error.message.includes('Invalid login credentials')) {
          setError(t('login.error.invalid'));
        } else {
          setError(error.message);
        }
        return;
      }

      console.log('[LOGIN] Login successful, redirecting to /dashboard');
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(t('login.error.failed'));
      console.error('[LOGIN] Login error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    console.log('[LOGIN] handleLogin called, email state:', email, 'password length:', password.length);

    // Fall back to DOM values if React state is empty (extension autofill issue)
    let loginEmail = email;
    let loginPassword = password;
    if (!loginEmail || !loginPassword) {
      const emailInput = document.getElementById('email') as HTMLInputElement;
      const passwordInput = document.getElementById('password') as HTMLInputElement;
      if (emailInput?.value) loginEmail = emailInput.value;
      if (passwordInput?.value) loginPassword = passwordInput.value;
      console.log('[LOGIN] Falling back to DOM values, email:', loginEmail);
    }

    if (!loginEmail || !loginPassword) {
      setError('メールアドレスとパスワードを入力してください');
      return;
    }

    await doLogin(loginEmail, loginPassword);
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
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

          {/* Form */}
          <form ref={formRef} onSubmit={handleLogin} className="space-y-5">
            {/* Email Field */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                {t('login.email')}
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onInput={(e) => {
                  const target = e.target as HTMLInputElement;
                  if (target.value && !email) {
                    setEmail(target.value);
                  }
                }}
                placeholder="your@email.com"
                required
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
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onInput={(e) => {
                  const target = e.target as HTMLInputElement;
                  if (target.value && !password) {
                    setPassword(target.value);
                  }
                }}
                placeholder="••••••••"
                required
                className="w-full px-4 py-3 bg-white border border-blue-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent transition-all"
              />
            </div>

            {/* Submit Button */}
            <button
              type="button"
              disabled={isLoading}
              onClick={() => handleLogin()}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors duration-200 mt-6"
            >
              {isLoading ? t('login.loading') : t('login.submit')}
            </button>
          </form>

          {/* Divider */}
          <div className="my-6 flex items-center gap-4">
            <div className="flex-1 h-px bg-blue-200"></div>
            <span className="text-gray-500 text-sm">{t('login.or')}</span>
            <div className="flex-1 h-px bg-blue-200"></div>
          </div>

          {/* Register Link */}
          <p className="text-center text-gray-600">
            {t('login.noAccount')}
            <Link href="/register" className="text-blue-500 hover:text-blue-600 font-semibold ml-1">
              {t('login.register')}
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
