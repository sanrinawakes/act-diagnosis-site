'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';

function ClaimSubscriptionContent() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const router = useRouter();
  const supabase = createClient();

  const submitClaim = async (action: 'request_code' | 'verify_code') => {
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
        body: JSON.stringify({
          action,
          email: trimmed,
          ...(action === 'verify_code' ? { code: code.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, message: data.error || '紐付けに失敗しました' });
        return;
      }
      setResult({ ok: true, message: data.message || '処理が完了しました' });
      if (data.status === 'code_sent') {
        setCodeSent(true);
        return;
      }
      if (data.status === 'claimed' || data.status === 'already_active') {
        setTimeout(() => router.push('/dashboard'), 2500);
      }
    } catch (err) {
      console.error(err);
      setResult({ ok: false, message: '予期しないエラーが発生しました' });
    } finally {
      setLoading(false);
    }
  };

  const handleRequestCode = () => submitClaim('request_code');

  const handleVerifyCode = () => {
    if (!/^\d{6}$/.test(code.trim())) {
      setResult({
        ok: false,
        message: 'メールに記載された6桁の確認コードを入力してください',
      });
      return;
    }
    void submitClaim('verify_code');
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
            {codeSent && (
              <div>
                <label htmlFor="claim-code" className="block text-sm font-medium text-gray-700 mb-2">
                  メールに届いた6桁の確認コード
                </label>
                <input
                  id="claim-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  disabled={loading}
                  className="w-full px-4 py-3 bg-white border border-blue-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-50"
                />
              </div>
            )}
            {result && (
              <div className={`p-3 rounded-lg border text-sm ${result.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                {result.message}
              </div>
            )}
            {!codeSent ? (
              <button
                type="button"
                onClick={handleRequestCode}
                disabled={loading}
                className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-semibold rounded-lg transition-colors disabled:cursor-not-allowed"
              >
                {loading ? '確認コードを送信中…' : '確認コードを送信する'}
              </button>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={handleVerifyCode}
                  disabled={loading}
                  className="py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-semibold rounded-lg transition-colors disabled:cursor-not-allowed"
                >
                  {loading ? '確認中…' : 'コードを確認する'}
                </button>
                <button
                  type="button"
                  onClick={handleRequestCode}
                  disabled={loading}
                  className="py-3 bg-white text-blue-600 border border-blue-200 rounded-lg font-medium hover:bg-blue-50 transition-colors disabled:opacity-50"
                >
                  コードを再送する
                </button>
              </div>
            )}
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
