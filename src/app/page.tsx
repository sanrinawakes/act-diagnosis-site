'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import Header from '@/components/Header';
import type { User } from '@supabase/supabase-js';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
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
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, [supabase]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
      </div>
    );
  }

  return (
    <main className="min-h-screen">
      <Header />
      {/* Hero Section */}
      <div className="relative overflow-hidden">
        {/* Background decorative elements */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob"></div>
          <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000"></div>
          <div className="absolute top-1/2 left-1/2 w-80 h-80 bg-cyan-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-4000"></div>
        </div>

        {/* Content */}
        <div className="relative z-10 px-4 sm:px-6 lg:px-8 py-20 sm:py-32 lg:py-40">
          <div className="max-w-4xl mx-auto text-center">
            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-gray-900 mb-6 drop-shadow-lg">
              ACT診断
            </h1>
            <p className="text-lg sm:text-xl text-gray-600 mb-12 max-w-2xl mx-auto drop-shadow">
              あなたの意識レベルと行動パターンを診断し、
              <br />
              AI コーチングで自己成長をサポートします
            </p>

            {user ? (
              // Logged in state
              <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
                <Link
                  href="/dashboard"
                  className="px-8 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors duration-200 shadow-lg"
                >
                  マイページへ
                </Link>
                <Link
                  href="/diagnosis"
                  className="px-8 py-3 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg transition-colors duration-200 shadow-lg"
                >
                  診断を受ける
                </Link>
                <Link
                  href="/coaching"
                  className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors duration-200 shadow-lg"
                >
                  AIコーチング
                </Link>
              </div>
            ) : (
              // Not logged in state
              <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
                <Link
                  href="/login"
                  className="px-8 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors duration-200 shadow-lg"
                >
                  ログイン
                </Link>
                <Link
                  href="/register"
                  className="px-8 py-3 bg-white hover:bg-gray-100 text-blue-500 font-semibold rounded-lg transition-colors duration-200 shadow-lg"
                >
                  新規登録
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div className="relative z-10 px-4 sm:px-6 lg:px-8 py-16 sm:py-20">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-3 gap-8">
            {/* Feature 1 */}
            <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50 hover:border-blue-300/70 transition-all duration-200">
              <div className="w-12 h-12 bg-blue-500 rounded-lg flex items-center justify-center mb-4">
                <span className="text-white text-xl">📋</span>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">詳細診断</h3>
              <p className="text-gray-600 text-sm">
                27 種類の ACT タイプと 6 つの意識レベルから、
                あなたの特性を正確に診断します
              </p>
            </div>

            {/* Feature 2 */}
            <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50 hover:border-blue-300/70 transition-all duration-200">
              <div className="w-12 h-12 bg-pink-500 rounded-lg flex items-center justify-center mb-4">
                <span className="text-white text-xl">🤖</span>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">AI コーチング</h3>
              <p className="text-gray-600 text-sm">
                あなたの診断結果に基づいて、
                AI コーチが個別にサポートします
              </p>
            </div>

            {/* Feature 3 */}
            <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50 hover:border-blue-300/70 transition-all duration-200">
              <div className="w-12 h-12 bg-cyan-500 rounded-lg flex items-center justify-center mb-4">
                <span className="text-white text-xl">📊</span>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">進捗管理</h3>
              <p className="text-gray-600 text-sm">
                診断結果を記録して、
                あなたの成長を可視化できます
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
