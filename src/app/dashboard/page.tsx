'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import type { Profile, DiagnosisResult } from '@/lib/types';
import { typeNames, levelNames } from '@/data/type-names';

export default function DashboardPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [latestDiagnosis, setLatestDiagnosis] = useState<DiagnosisResult | null>(null);
  const [diagnosisCount, setDiagnosisCount] = useState<number>(0);
  const [chatSessionCount, setChatSessionCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          router.push('/login');
          return;
        }

        // プロフィール取得
        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .single();

        if (profileData) {
          setProfile(profileData);
        }

        // 最新の診断結果取得
        const { data: diagnosisData, count: dCount } = await supabase
          .from('diagnosis_results')
          .select('*', { count: 'exact' })
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1);

        if (diagnosisData && diagnosisData.length > 0) {
          setLatestDiagnosis(diagnosisData[0]);
        }
        setDiagnosisCount(dCount || 0);

        // チャットセッション数取得
        const { count: cCount } = await supabase
          .from('chat_sessions')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id);

        setChatSessionCount(cCount || 0);
      } catch (err) {
        console.error('Failed to fetch dashboard data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, [router, supabase]);

  if (loading) {
    return (
      <AuthGuard>
        <Header />
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            <p className="text-gray-300">読み込み中...</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <Header />
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* 挨拶セクション */}
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">
              {profile?.display_name
                ? `${profile.display_name}さん、こんにちは`
                : 'マイページ'}
            </h1>
            <p className="text-gray-400">ACT診断コーチングへようこそ</p>
          </div>

          {/* 統計カード */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
            <div className="bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-700/50 rounded-xl p-6">
              <p className="text-gray-400 text-sm">診断回数</p>
              <p className="text-4xl font-bold text-white mt-2">{diagnosisCount}</p>
            </div>
            <div className="bg-gradient-to-br from-purple-900/40 to-pink-900/40 border border-purple-700/50 rounded-xl p-6">
              <p className="text-gray-400 text-sm">チャットセッション</p>
              <p className="text-4xl font-bold text-white mt-2">{chatSessionCount}</p>
            </div>
            <div className="bg-gradient-to-br from-pink-900/40 to-indigo-900/40 border border-pink-700/50 rounded-xl p-6">
              <p className="text-gray-400 text-sm">現在のタイプ</p>
              <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text mt-2">
                {latestDiagnosis ? latestDiagnosis.type_code : '未診断'}
              </p>
            </div>
          </div>

          {/* 最新診断結果 */}
          {latestDiagnosis ? (
            <div className="bg-gradient-to-br from-indigo-900/30 to-purple-900/30 border border-indigo-700/50 rounded-xl p-6 mb-8">
              <h2 className="text-xl font-semibold text-white mb-4">最新の診断結果</h2>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                <div>
                  <div className="text-6xl font-bold text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text">
                    {latestDiagnosis.type_code}
                  </div>
                  <p className="text-gray-300 mt-1">
                    {typeNames[latestDiagnosis.type_code] || latestDiagnosis.type_code}
                  </p>
                </div>
                <div>
                  <span className="inline-block bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-2 rounded-full font-semibold text-sm">
                    意識レベル {latestDiagnosis.consciousness_level}: {levelNames[latestDiagnosis.consciousness_level]}
                  </span>
                  <p className="text-gray-400 text-sm mt-2">
                    診断日: {new Date(latestDiagnosis.created_at).toLocaleDateString('ja-JP', {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-col sm:flex-row gap-3">
                <Link
                  href={`/results/${latestDiagnosis.id}`}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition-colors text-center"
                >
                  詳細を見る
                </Link>
                <Link
                  href={`/coaching?code=${latestDiagnosis.type_code}-${latestDiagnosis.consciousness_level}`}
                  className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg transition-colors text-center"
                >
                  AIコーチングを受ける
                </Link>
              </div>
            </div>
          ) : (
            <div className="bg-gradient-to-br from-indigo-900/30 to-purple-900/30 border border-indigo-700/50 rounded-xl p-8 mb-8 text-center">
              <p className="text-xl text-gray-300 mb-4">まだ診断を受けていません</p>
              <p className="text-gray-400 mb-6">
                ACT診断であなたのタイプと意識レベルを確認しましょう
              </p>
              <Link
                href="/diagnosis"
                className="inline-block px-8 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold rounded-lg transition-all"
              >
                診断を受ける
              </Link>
            </div>
          )}

          {/* クイックアクション */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Link
              href="/diagnosis"
              className="bg-gradient-to-br from-indigo-900/30 to-purple-900/30 border border-indigo-700/50 rounded-xl p-5 hover:border-indigo-500/70 transition-all group"
            >
              <div className="text-2xl mb-2">📋</div>
              <h3 className="text-white font-semibold group-hover:text-indigo-300 transition-colors">診断を受ける</h3>
              <p className="text-gray-400 text-sm mt-1">ACTタイプを診断</p>
            </Link>

            <Link
              href="/results"
              className="bg-gradient-to-br from-purple-900/30 to-pink-900/30 border border-purple-700/50 rounded-xl p-5 hover:border-purple-500/70 transition-all group"
            >
              <div className="text-2xl mb-2">📊</div>
              <h3 className="text-white font-semibold group-hover:text-purple-300 transition-colors">診断履歴</h3>
              <p className="text-gray-400 text-sm mt-1">過去の結果一覧</p>
            </Link>

            <Link
              href="/coaching"
              className="bg-gradient-to-br from-pink-900/30 to-indigo-900/30 border border-pink-700/50 rounded-xl p-5 hover:border-pink-500/70 transition-all group"
            >
              <div className="text-2xl mb-2">🤖</div>
              <h3 className="text-white font-semibold group-hover:text-pink-300 transition-colors">AIコーチング</h3>
              <p className="text-gray-400 text-sm mt-1">AIに相談する</p>
            </Link>

            <Link
              href="/profile"
              className="bg-gradient-to-br from-slate-900/30 to-indigo-900/30 border border-slate-700/50 rounded-xl p-5 hover:border-slate-500/70 transition-all group"
            >
              <div className="text-2xl mb-2">👤</div>
              <h3 className="text-white font-semibold group-hover:text-gray-300 transition-colors">プロフィール</h3>
              <p className="text-gray-400 text-sm mt-1">アカウント設定</p>
            </Link>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
