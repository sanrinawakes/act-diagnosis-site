'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';

function ClaimSubscriptionContent() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const router = useRouter();
  const supabase = createClient();

  const handleClaim = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setResult({ ok: false, message: 'メールアドレスを入力してください' });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setResult({ ok: false, message: 'ログインが切れています。再度ログインしてください。' });
        return;
      }
      const res = await fetch('/api/claim-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.access_token,
        },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, message: data.error || '紐付けに失敗しました' });
        return;
      }
      setResult({ ok: true, message: data.message || '紐付けが完了しました' });
      setTimeout(() => router.push('/dashboard'), 2500);
    } catch (err) {
      console.error(err);
      setResult({ ok: false, message: '予期しないエラーが発生しました' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-100 via-blue-50 to-blue-100">
      <Header />
      <main className="max-w-2xl mx-auto p-6 sm:p-10">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl p-6 sm:p-8 border border-blue-200/60 shadow-xl">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-4">サブスクリプション紐付け</h1>
          <div className="space-y-3 text-gray-700 text-sm sm:text-base mb-6">
            <p>AWAKES（MyASP）で決済済みなのに、ACTIで有料機能が使えない場合はこちらで紐付けてください。</p>
            <p className="text-gray-600 text-sm">AWAKESに登録しているメールアドレスを入力してください。ACTIに登録しているメールアドレスと異なっていても紐付け可能です。</p>
          </div>
          <div className="space-y-4">
            <div>
              <label htmlFor="awakes-email" className="block text-sm font-medium text-gray-700 mb-2">
                AWAKESで決済時に使ったメールアドレス
              </label>
              <input
                id="awakes-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="awakes-email@example.com"
                disabled={loading}
                className="w-full px-4 py-3 bg-white border border-blue-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-50"
              />
            </div>
            {result && (
              <div className={`p-3 rounded-lg border text-sm ${result.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                {result.message}
              </div>
            )}
            <button
              type="button"
              onClick={handleClaim}
              disabled={loading}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-semibold rounded-lg transition-colors disabled:cursor-not-allowed"
            >
              {loading ? '紐付け中…' : '有料機能を紐付ける'}
            </button>
            <div className="text-center mt-4">
              <Link href="/dashboard" className="text-blue-500 hover:text-blue-700 text-sm">ダッシュボードに戻る</Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function ClaimSubscriptionPage() {
  return (
    <AuthGuard>
      <ClaimSubscriptionContent />
    </AuthGuard>
  );
}
