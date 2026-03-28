'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/lib/types';

export default function Header() {
  const { locale, setLocale, t } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        setUser(user);

        if (user) {
          const { data } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

          if (data) {
            setProfile(data);
          }
        }
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        setUser(session.user);
        const { data } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();
        if (data) {
          setProfile(data);
        }
      } else {
        setUser(null);
        setProfile(null);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, [supabase]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setIsMenuOpen(false);
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-blue-200/60 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center gap-2 text-2xl font-bold text-gray-900 hover:text-blue-600 transition-colors"
          >
            <span>🎯</span>
            <span>{t('nav.siteName')}</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            {user ? (
              <>
                <Link href="/dashboard" className="px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all">
                  {t('nav.mypage')}
                </Link>
                <Link href="/diagnosis" className="px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all">
                  {t('nav.diagnosis')}
                </Link>
                <Link href="/results" className="px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all">
                  {t('nav.results')}
                </Link>
                <Link href="/coaching" className="px-4 py-2 text-gray-600 hover:text-pink-500 hover:bg-pink-50 rounded-lg transition-all">
                  {t('nav.coaching')}
                </Link>
                <Link href="/profile" className="px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all">
                  {t('nav.profile')}
                </Link>
                <Link href="/support" className="px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all">
                  サポート
                </Link>

                {profile?.role === 'admin' && (
                  <Link href="/admin" className="px-4 py-2 text-pink-500 hover:text-pink-600 hover:bg-pink-50 rounded-lg transition-all font-semibold">
                    {t('nav.admin')}
                  </Link>
                )}

                <button onClick={handleLogout} className="px-4 py-2 text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all">
                  {t('nav.logout')}
                </button>
              </>
            ) : (
              <>
                <Link href="/login" className="px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all">
                  {t('nav.login')}
                </Link>
                <Link href="/register" className="px-4 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors">
                  {t('nav.register')}
                </Link>
              </>
            )}

            {/* Language Toggle */}
            <button
              onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')}
              className="ml-2 px-3 py-1.5 text-sm font-medium border border-blue-200 rounded-lg hover:bg-blue-50 transition-all text-gray-600"
            >
              {locale === 'ja' ? 'EN' : 'JA'}
            </button>
          </nav>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden p-2 hover:bg-blue-50 rounded-lg transition-all"
          >
            <svg
              className="w-6 h-6 text-gray-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              {isMenuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile Navigation Menu */}
        {isMenuOpen && (
          <nav className="md:hidden pb-4 space-y-2">
            {user ? (
              <>
                <Link
                  href="/dashboard"
                  className="block px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  onClick={() => setIsMenuOpen(false)}
                >
                  {t('nav.mypage')}
                </Link>
                <Link
                  href="/diagnosis"
                  className="block px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  onClick={() => setIsMenuOpen(false)}
                >
                  {t('nav.diagnosis')}
                </Link>
                <Link
                  href="/results"
                  className="block px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  onClick={() => setIsMenuOpen(false)}
                >
                  {t('nav.results')}
                </Link>
                <Link
                  href="/coaching"
                  className="block px-4 py-2 text-gray-600 hover:text-pink-500 hover:bg-pink-50 rounded-lg transition-all"
                  onClick={() => setIsMenuOpen(false)}
                >
                  {t('nav.coaching')}
                </Link>
                <Link
                  href="/profile"
                  className="block px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  onClick={() => setIsMenuOpen(false)}
                >
                  {t('nav.profile')}
                </Link>
                <Link
                  href="/support"
                  className="block px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  onClick={() => setIsMenuOpen(false)}
                >
                  サポート
                </Link>

                {profile?.role === 'admin' && (
                  <Link
                    href="/admin"
                    className="block px-4 py-2 text-pink-500 hover:text-pink-600 hover:bg-pink-50 rounded-lg transition-all font-semibold"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {t('nav.admin')}
                  </Link>
                )}

                <button
                  onClick={handleLogout}
                  className="w-full text-left px-4 py-2 text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                >
                  {t('nav.logout')}
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="block px-4 py-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  onClick={() => setIsMenuOpen(false)}
                >
                  {t('nav.login')}
                </Link>
                <Link
                  href="/register"
                  className="block px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
                  onClick={() => setIsMenuOpen(false)}
                >
                  {t('nav.register')}
                </Link>
              </>
            )}

            {/* Mobile Language Toggle */}
            <button
              onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')}
              className="w-full text-left px-4 py-2 text-sm font-medium text-gray-600 hover:bg-blue-50 rounded-lg transition-all"
            >
              {locale === 'ja' ? '🌐 Switch to English' : '🌐 日本語に切り替え'}
            </button>
          </nav>
        )}
      </div>
    </header>
  );
}
