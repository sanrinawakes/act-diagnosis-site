'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();

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
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-600">{t('common.loading')}</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <Header />
      <div className="min-h-screen">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* 挨拶セクション */}
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-2">
              {profile?.display_name
                ? `${profile.display_name}${t('dashboard.greeting')}`
                : t('dashboard.default')}
            </h1>
            <p className="text-gray-600">{t('dashboard.welcome')}</p>
          </div>

          {/* 統計カード */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
            <div className="bg-white/80 border border-blue-200/50 rounded-xl p-6">
              <p className="text-gray-600 text-sm">{t('dashboard.diagnosisCount')}</p>
              <p className="text-4xl font-bold text-gray-900 mt-2">{diagnosisCount}</p>
            </div>
            <div className="bg-white/80 border border-pink-200/50 rounded-xl p-6">
              <p className="text-gray-600 text-sm">{t('dashboard.chatSessions')}</p>
              <p className="text-4xl font-bold text-gray-900 mt-2">{chatSessionCount}</p>
            </div>
            <div className="bg-white/80 border border-blue-200/50 rounded-xl p-6">
              <p className="text-gray-600 text-sm">{t('dashboard.currentType')}</p>
              <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-blue-600 via-pink-500 to-blue-500 bg-clip-text mt-2">
                {latestDiagnosis ? latestDiagnosis.type_code : t('dashboard.undiagnosed')}
              </p>
            </div>
          </div>

          {/* 最新診断結果 */}
          {latestDiagnosis ? (
            <div className="bg-white/80 border border-blue-200/50 rounded-xl p-6 mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">{t('dashboard.latestResult')}</h2>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                <div>
                  <div className="text-6xl font-bold text-transparent bg-gradient-to-r from-blue-600 via-pink-500 to-blue-500 bg-clip-text">
                    {latestDiagnosis.type_code}
                  </div>
                  <p className="text-gray-700 mt-1">
                    {typeNames[latestDiagnosis.type_code] || latestDiagnosis.type_code}
                  </p>
                </div>
                <div>
                  <span className="inline-block bg-blue-500 text-white px-4 py-2 rounded-full font-semibold text-sm">
                    {t('dashboard.level')} {latestDiagnosis.consciousness_level}: {levelNames[latestDiagnosis.consciousness_level]}
                  </span>
                  <p className="text-gray-600 text-sm mt-2">
                    {t('dashboard.diagnosisDate')}: {new Date(latestDiagnosis.created_at).toLocaleDateString('ja-JP', {
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
                  className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-center"
                >
                  {t('dashboard.viewDetail')}
                </Link>
                <Link
                  href={`/coaching?code=${latestDiagnosis.type_code}-${latestDiagnosis.consciousness_level}`}
                  className="px-6 py-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg transition-colors text-center"
                >
                  {t('dashboard.getCoaching')}
                </Link>
              </div>
            </div>
          ) : (
            <div className="bg-white/80 border border-blue-200/50 rounded-xl p-8 mb-8 text-center">
              <p className="text-xl text-gray-700 mb-4">{t('dashboard.noDiagnosis')}</p>
              <p className="text-gray-600 mb-6">
                {t('dashboard.noDiagnosisDesc')}
              </p>
              <Link
                href="/diagnosis"
                className="inline-block px-8 py-3 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold rounded-lg transition-all"
              >
                {t('dashboard.takeDiagnosis')}
              </Link>
            </div>
          )}

          {/* クイックアクション */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Link
              href="/diagnosis"
              className="bg-white/70 border border-blue-200/50 rounded-xl p-5 hover:border-blue-300 transition-all group"
            >
              <div className="text-2xl mb-2">📋</div>
              <h3 className="text-gray-900 font-semibold group-hover:text-blue-600 transition-colors">{t('dashboard.quickDiagnosis')}</h3>
              <p className="text-gray-600 text-sm mt-1">{t('dashboard.quickDiagnosisDesc')}</p>
            </Link>

            <Link
              href="/results"
              className="bg-white/70 border border-pink-200/50 rounded-xl p-5 hover:border-pink-300 transition-all group"
            >
              <div className="text-2xl mb-2">📊</div>
              <h3 className="text-gray-900 font-semibold group-hover:text-pink-600 transition-colors">{t('dashboard.quickHistory')}</h3>
              <p className="text-gray-600 text-sm mt-1">{t('dashboard.quickHistoryDesc')}</p>
            </Link>

            <Link
              href="/coaching"
              className="bg-white/70 border border-blue-200/50 rounded-xl p-5 hover:border-blue-300 transition-all group"
            >
              <div className="text-2xl mb-2">🤖</div>
              <h3 className="text-gray-900 font-semibold group-hover:text-blue-600 transition-colors">{t('dashboard.quickCoaching')}</h3>
              <p className="text-gray-600 text-sm mt-1">{t('dashboard.quickCoachingDesc')}</p>
            </Link>

            <Link
              href="/profile"
              className="bg-white/70 border border-blue-200/50 rounded-xl p-5 hover:border-blue-300 transition-all group"
            >
              <div className="text-2xl mb-2">👤</div>
              <h3 className="text-gray-900 font-semibold group-hover:text-blue-600 transition-colors">{t('dashboard.quickProfile')}</h3>
              <p className="text-gray-600 text-sm mt-1">{t('dashboard.quickProfileDesc')}</p>
            </Link>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
