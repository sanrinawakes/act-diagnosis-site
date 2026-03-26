'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';

export default function FreeLandingPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Check if already has email in localStorage
  useEffect(() => {
    const savedEmail = localStorage.getItem('free_user_email');
    if (savedEmail) {
      router.push('/free/diagnosis');
    }
  }, [router]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validate email
    if (!email || !email.includes('@')) {
      setError('有効なメールアドレスを入力してください');
      return;
    }

    // Store email in localStorage
    localStorage.setItem('free_user_email', email);
    setIsLoading(true);

    // Redirect to diagnosis
    router.push('/free/diagnosis');
  };

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
        <div className="relative z-10 px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="max-w-2xl mx-auto text-center">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 mb-6 drop-shadow-lg">
              あなたの意識タイプを無料で診断
            </h1>
            <p className="text-lg sm:text-xl text-gray-600 mb-4 drop-shadow">
              メールアドレスだけで簡単スタート
            </p>
            <p className="text-base sm:text-lg text-gray-600 mb-12 drop-shadow">
              15問の簡易テスト + AIコーチング3回/日
            </p>

            {/* Email Form */}
            <form onSubmit={handleSubmit} className="max-w-md mx-auto">
              <div className="space-y-4">
                <div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="メールアドレスを入力"
                    className="w-full px-6 py-4 border-2 border-blue-200 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 text-gray-900 placeholder-gray-500"
                    disabled={isLoading}
                  />
                  {error && (
                    <p className="text-red-500 text-sm mt-2">{error}</p>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-4 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300 shadow-lg"
                >
                  {isLoading ? '処理中...' : '無料診断を始める'}
                </button>
              </div>
            </form>

            {/* Features */}
            <div className="mt-16 grid md:grid-cols-3 gap-6 max-w-3xl mx-auto">
              <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                <div className="text-3xl mb-3">✓</div>
                <h3 className="font-semibold text-gray-900 mb-2">ログイン不要</h3>
                <p className="text-sm text-gray-600">メールアドレスだけで簡単開始</p>
              </div>
              <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                <div className="text-3xl mb-3">⚡</div>
                <h3 className="font-semibold text-gray-900 mb-2">15問で完結</h3>
                <p className="text-sm text-gray-600">5分で意識レベルを診断</p>
              </div>
              <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                <div className="text-3xl mb-3">🤖</div>
                <h3 className="font-semibold text-gray-900 mb-2">AIコーチング</h3>
                <p className="text-sm text-gray-600">毎日3回まで無料で相談可能</p>
              </div>
            </div>

            {/* Info Section */}
            <div className="mt-16 bg-white/70 backdrop-blur rounded-xl p-8 border border-blue-200/50 max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">簡易診断の特徴</h2>
              <div className="space-y-3 text-left text-gray-700">
                <p>フルテスト（42問）では、27種類の性格タイプと6段階の意識レベルをより正確に判定できます。</p>
                <p className="font-semibold text-blue-600">無料オンライン勉強会に参加すると、フルテスト＋2週間のAIコーチング無制限利用がプレゼントされます。</p>
              </div>
            </div>

            {/* Divider */}
            <div className="mt-12 flex items-center gap-4 justify-center">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent to-blue-200"></div>
              <span className="text-gray-600 text-sm">または</span>
              <div className="h-px flex-1 bg-gradient-to-l from-transparent to-blue-200"></div>
            </div>

            {/* Login Link */}
            <div className="mt-8">
              <p className="text-gray-600 mb-4">すでにアカウントをお持ちですか？</p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link
                  href="/login"
                  className="px-8 py-3 bg-white hover:bg-gray-100 text-blue-500 font-semibold rounded-lg transition-colors duration-200 border border-blue-200"
                >
                  ログイン
                </Link>
                <Link
                  href="/register"
                  className="px-8 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors duration-200"
                >
                  新規登録
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
