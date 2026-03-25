'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';

interface DashboardStats {
  totalUsers: number;
  totalResults: number;
  botEnabled: boolean;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);

        // Fetch total users count
        const { count: usersCount, error: usersError } = await supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true });

        if (usersError) throw usersError;

        // Fetch total diagnosis results count
        const { count: resultsCount, error: resultsError } = await supabase
          .from('diagnosis_results')
          .select('*', { count: 'exact', head: true });

        if (resultsError) throw resultsError;

        // Fetch site settings
        const { data: settings, error: settingsError } = await supabase
          .from('site_settings')
          .select('bot_enabled')
          .limit(1)
          .single();

        if (settingsError && settingsError.code !== 'PGRST116') throw settingsError;

        setStats({
          totalUsers: usersCount || 0,
          totalResults: resultsCount || 0,
          botEnabled: settings?.bot_enabled ?? true,
        });
        setError(null);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
        setError('統計情報の取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [supabase]);

  return (
    <AdminGuard>
      <Header />
      <div className="min-h-screen">
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-gray-900 mb-2">管理者ダッシュボード</h1>
            <p className="text-gray-600">サイト統計情報と設定管理</p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex justify-center items-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            </div>
          )}

          {/* Stats Cards */}
          {!loading && stats && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                {/* Total Users Card */}
                <div className="bg-white/80 border border-blue-200/50 rounded-lg p-6 shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-gray-600 text-sm font-medium">ユーザー数</p>
                      <p className="text-4xl font-bold text-gray-900 mt-2">{stats.totalUsers}</p>
                      <p className="text-gray-600 text-xs mt-1">登録済みユーザー</p>
                    </div>
                    <div className="text-blue-500 text-3xl">👥</div>
                  </div>
                </div>

                {/* Total Results Card */}
                <div className="bg-white/80 border border-blue-200/50 rounded-lg p-6 shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-gray-600 text-sm font-medium">診断結果数</p>
                      <p className="text-4xl font-bold text-gray-900 mt-2">{stats.totalResults}</p>
                      <p className="text-gray-600 text-xs mt-1">合計診断数</p>
                    </div>
                    <div className="text-blue-600 text-3xl">📊</div>
                  </div>
                </div>

                {/* Bot Status Card */}
                <div className="bg-white/80 border border-blue-200/50 rounded-lg p-6 shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-gray-600 text-sm font-medium">AIコーチングボット</p>
                      <div className="flex items-center gap-2 mt-2">
                        <div
                          className={`h-3 w-3 rounded-full ${
                            stats.botEnabled ? 'bg-green-500' : 'bg-gray-500'
                          }`}
                        ></div>
                        <p className="text-2xl font-bold text-gray-900">
                          {stats.botEnabled ? 'ON' : 'OFF'}
                        </p>
                      </div>
                      <p className="text-gray-600 text-xs mt-1">
                        {stats.botEnabled ? '有効' : '無効'}
                      </p>
                    </div>
                    <div className="text-blue-500 text-3xl">🤖</div>
                  </div>
                </div>
              </div>

              {/* Navigation Links */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* User Management Link */}
                <Link
                  href="/admin/users"
                  className="bg-white/80 border border-blue-200/50 rounded-lg p-6 hover:border-blue-300 hover:shadow-md transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <h2 className="text-xl font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                      ユーザー管理
                    </h2>
                    <span className="text-2xl">👤</span>
                  </div>
                  <p className="text-gray-600 text-sm mb-4">
                    ユーザーアカウントの管理、役割変更、アクティベーション/デアクティベーション
                  </p>
                  <p className="text-blue-600 text-sm font-medium">詳細を表示 →</p>
                </Link>

                {/* Diagnosis Data Link */}
                <Link
                  href="/admin/diagnoses"
                  className="bg-white/80 border border-pink-200/50 rounded-lg p-6 hover:border-pink-300 hover:shadow-md transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <h2 className="text-xl font-semibold text-gray-900 group-hover:text-pink-600 transition-colors">
                      診断データ
                    </h2>
                    <span className="text-2xl">📊</span>
                  </div>
                  <p className="text-gray-600 text-sm mb-4">
                    全ユーザーの診断結果を閲覧、タイプ・レベル分布の統計
                  </p>
                  <p className="text-pink-600 text-sm font-medium">詳細を表示 →</p>
                </Link>

                {/* People Management Link */}
                <Link
                  href="/admin/people"
                  className="bg-white/80 border border-pink-200/50 rounded-lg p-6 hover:border-pink-300 hover:shadow-md transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <h2 className="text-xl font-semibold text-gray-900 group-hover:text-pink-600 transition-colors">
                      人材管理
                    </h2>
                    <span className="text-2xl">👥</span>
                  </div>
                  <p className="text-gray-600 text-sm mb-4">
                    人物情報の登録・管理（名前、タイプコード、意識レベル、最大100名）
                  </p>
                  <p className="text-pink-600 text-sm font-medium">詳細を表示 →</p>
                </Link>

                {/* Settings Link */}
                <Link
                  href="/admin/settings"
                  className="bg-white/80 border border-blue-200/50 rounded-lg p-6 hover:border-blue-300 hover:shadow-md transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <h2 className="text-xl font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                      サイト設定
                    </h2>
                    <span className="text-2xl">⚙️</span>
                  </div>
                  <p className="text-gray-600 text-sm mb-4">
                    AIボット、メンテナンスモード、その他のサイト設定を管理
                  </p>
                  <p className="text-blue-600 text-sm font-medium">詳細を表示 →</p>
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </AdminGuard>
  );
}
