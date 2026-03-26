'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';

export default function SubscriptionRequired() {
  const [email, setEmail] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    async function checkStatus() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        setEmail(user.email || null);

        const { data: profile } = await supabase
          .from('profiles')
          .select('subscription_status')
          .eq('id', user.id)
          .single();

        setSubscriptionStatus(profile?.subscription_status || 'none');
      }
      setLoading(false);
    }

    checkStatus();
  }, []);

  const getStatusMessage = () => {
    switch (subscriptionStatus) {
      case 'cancelled':
        return 'Awakesオンラインスクールの会員ステータスが「退会済み」になっています。';
      case 'payment_failed':
        return 'Awakesオンラインスクールの決済に問題が発生しています。';
      case 'none':
      default:
        return 'このサイトを利用するには、Awakesオンラインスクールの有料会員である必要があります。';
    }
  };

  return (
    <>
      <Header />
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-lg w-full">
          <div className="bg-white rounded-2xl shadow-lg border border-blue-100 p-8 text-center">
            {/* Icon */}
            <div className="w-20 h-20 mx-auto mb-6 bg-blue-50 rounded-full flex items-center justify-center">
              <svg
                className="w-10 h-10 text-blue-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>

            <h1 className="text-2xl font-bold text-gray-900 mb-4">
              有料会員専用コンテンツ
            </h1>

            {loading ? (
              <div className="animate-pulse h-6 bg-gray-200 rounded w-3/4 mx-auto"></div>
            ) : (
              <>
                <p className="text-gray-600 mb-6">{getStatusMessage()}</p>

                {email && (
                  <div className="bg-gray-50 rounded-lg p-4 mb-6">
                    <p className="text-sm text-gray-500">ログイン中のメールアドレス</p>
                    <p className="font-mono text-gray-700">{email}</p>
                    {subscriptionStatus && (
                      <p className="text-sm mt-2">
                        ステータス:{' '}
                        <span
                          className={`font-medium ${
                            subscriptionStatus === 'active'
                              ? 'text-green-600'
                              : subscriptionStatus === 'cancelled'
                              ? 'text-red-600'
                              : 'text-yellow-600'
                          }`}
                        >
                          {subscriptionStatus === 'active'
                            ? '有効'
                            : subscriptionStatus === 'cancelled'
                            ? '退会済み'
                            : subscriptionStatus === 'payment_failed'
                            ? '決済エラー'
                            : '未登録'}
                        </span>
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-3">
                  <p className="text-sm text-gray-500">
                    Awakesオンラインスクールに入会済みの方で、このメッセージが表示される場合は、
                    MyASPに登録しているメールアドレスと同じアドレスでアカウントを作成してください。
                    決済が確認され次第、自動的にアクセスが有効化されます。
                  </p>

                  <div className="flex flex-col gap-3 mt-6">
                    <Link
                      href="/register"
                      className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
                    >
                      新規アカウント作成
                    </Link>

                    <Link
                      href="/login"
                      className="w-full py-3 px-4 bg-white text-blue-600 border border-blue-200 rounded-lg font-medium hover:bg-blue-50 transition-colors"
                    >
                      別のアカウントでログイン
                    </Link>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
