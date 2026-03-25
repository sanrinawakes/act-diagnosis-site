'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import { createClient } from '@/lib/supabase';
import type { SiteSettings } from '@/lib/types';

export default function SiteSettings() {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [botEnabled, setBotEnabled] = useState(true);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const supabase = createClient();

  // Fetch settings on mount
  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/admin/settings', {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '設定の取得に失敗しました');
      }

      const data = (await response.json()) as SiteSettings;
      setSettings(data);
      setBotEnabled(data.bot_enabled);
      setMaintenanceMode(data.maintenance_mode);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      setError(err instanceof Error ? err.message : '設定の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!window.confirm('設定を保存してもよろしいですか？')) {
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const response = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_enabled: botEnabled,
          maintenance_mode: maintenanceMode,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '設定の保存に失敗しました');
      }

      const data = (await response.json()) as SiteSettings;
      setSettings(data);

      setSuccessMessage('設定が正常に保存されました');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setError(err instanceof Error ? err.message : '設定の保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = settings && (settings.bot_enabled !== botEnabled || settings.maintenance_mode !== maintenanceMode);

  return (
    <AdminGuard>
      <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-purple-950 to-slate-900">
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <div className="mb-8">
            <Link
              href="/admin"
              className="text-indigo-400 hover:text-indigo-300 text-sm mb-4 inline-block"
            >
              ← ダッシュボードに戻る
            </Link>
            <h1 className="text-4xl font-bold text-white">サイト設定</h1>
            <p className="text-gray-400 mt-1">グローバルサイト設定の管理</p>
          </div>

          {/* Success Message */}
          {successMessage && (
            <div className="mb-6 p-4 bg-green-900/50 border border-green-700 rounded-lg text-green-300">
              {successMessage}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-300">
              {error}
            </div>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex justify-center items-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            </div>
          )}

          {/* Settings Panel */}
          {!loading && settings && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Settings Cards */}
              <div className="lg:col-span-1 space-y-6">
                {/* Bot Setting */}
                <div className="bg-gradient-to-br from-indigo-900/30 to-purple-900/30 border border-indigo-700/50 rounded-lg p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h2 className="text-xl font-semibold text-white">AIコーチングボット</h2>
                      <p className="text-gray-400 text-sm mt-1">
                        ユーザーがAIコーチングボットを使用できるかどうかを制御します
                      </p>
                    </div>
                    <span className="text-2xl">🤖</span>
                  </div>

                  <div className="bg-indigo-950/40 border border-indigo-700/30 rounded p-4 mb-4">
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => setBotEnabled(true)}
                        className={`flex-1 px-4 py-3 rounded font-medium transition-all ${
                          botEnabled
                            ? 'bg-green-600 text-white shadow-lg'
                            : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        ON
                      </button>
                      <button
                        onClick={() => setBotEnabled(false)}
                        className={`flex-1 px-4 py-3 rounded font-medium transition-all ${
                          !botEnabled
                            ? 'bg-red-600 text-white shadow-lg'
                            : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        OFF
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div
                      className={`h-3 w-3 rounded-full ${
                        botEnabled ? 'bg-green-500' : 'bg-gray-500'
                      }`}
                    ></div>
                    <p className="text-sm text-gray-400">
                      現在: <span className="text-white font-medium">{botEnabled ? '有効' : '無効'}</span>
                    </p>
                  </div>
                </div>

                {/* Maintenance Mode Setting */}
                <div className="bg-gradient-to-br from-purple-900/30 to-slate-900/30 border border-purple-700/50 rounded-lg p-6 shadow-xl">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h2 className="text-xl font-semibold text-white">メンテナンスモード</h2>
                      <p className="text-gray-400 text-sm mt-1">
                        有効にするとサイトをメンテナンス中にできます
                      </p>
                    </div>
                    <span className="text-2xl">🔧</span>
                  </div>

                  <div className="bg-purple-950/40 border border-purple-700/30 rounded p-4 mb-4">
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => setMaintenanceMode(false)}
                        className={`flex-1 px-4 py-3 rounded font-medium transition-all ${
                          !maintenanceMode
                            ? 'bg-green-600 text-white shadow-lg'
                            : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        運用中
                      </button>
                      <button
                        onClick={() => setMaintenanceMode(true)}
                        className={`flex-1 px-4 py-3 rounded font-medium transition-all ${
                          maintenanceMode
                            ? 'bg-orange-600 text-white shadow-lg'
                            : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        メンテナンス中
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div
                      className={`h-3 w-3 rounded-full ${
                        maintenanceMode ? 'bg-orange-500' : 'bg-green-500'
                      }`}
                    ></div>
                    <p className="text-sm text-gray-400">
                      現在: <span className="text-white font-medium">
                        {maintenanceMode ? 'メンテナンス中' : '運用中'}
                      </span>
                    </p>
                  </div>
                </div>
              </div>

              {/* Info and Save Section */}
              <div className="lg:col-span-1">
                {/* Current Settings Info */}
                <div className="bg-gradient-to-br from-slate-900/40 to-indigo-900/40 border border-slate-700/50 rounded-lg p-6 shadow-xl mb-6">
                  <h3 className="text-lg font-semibold text-white mb-4">設定情報</h3>

                  <div className="space-y-4">
                    <div className="border-b border-slate-700/30 pb-3">
                      <p className="text-gray-500 text-xs uppercase">最終更新日時</p>
                      <p className="text-white mt-1">
                        {settings.updated_at
                          ? new Date(settings.updated_at).toLocaleString('ja-JP')
                          : '未更新'}
                      </p>
                    </div>

                    <div>
                      <p className="text-gray-500 text-xs uppercase">最終更新者</p>
                      <p className="text-white mt-1">
                        {settings.updated_by || '未設定'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Save Button */}
                <div className="flex flex-col gap-3">
                  <button
                    onClick={handleSaveSettings}
                    disabled={!hasChanges || saving}
                    className={`w-full px-6 py-3 rounded-lg font-semibold transition-all ${
                      hasChanges && !saving
                        ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg'
                        : 'bg-gray-700 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {saving ? '保存中...' : hasChanges ? '設定を保存' : '変更なし'}
                  </button>

                  {!hasChanges && (
                    <p className="text-center text-gray-500 text-sm">
                      すべての設定は変更されていません
                    </p>
                  )}
                </div>

                {/* Info Box */}
                <div className="mt-6 bg-indigo-950/50 border border-indigo-700/30 rounded-lg p-4">
                  <p className="text-indigo-300 text-sm">
                    <span className="font-semibold">💡 ヒント:</span> 設定を変更してから保存ボタンをクリックしてください。確認ダイアログが表示されます。
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminGuard>
  );
}
