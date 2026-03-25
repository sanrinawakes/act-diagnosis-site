'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { typeNames, levelNames } from '@/data/type-names';

interface DiagnosisWithUser {
  id: string;
  user_id: string;
  type_code: string;
  consciousness_level: number;
  created_at: string;
  user_email: string;
  user_display_name: string | null;
}

const ITEMS_PER_PAGE = 20;

export default function AdminDiagnosesPage() {
  const [diagnoses, setDiagnoses] = useState<DiagnosisWithUser[]>([]);
  const [filteredDiagnoses, setFilteredDiagnoses] = useState<DiagnosisWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterLevel, setFilterLevel] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const supabase = createClient();

  useEffect(() => {
    const fetchDiagnoses = async () => {
      try {
        setLoading(true);

        // 診断結果を全件取得
        const { data: results, error: resultsError } = await supabase
          .from('diagnosis_results')
          .select('id, user_id, type_code, consciousness_level, created_at')
          .order('created_at', { ascending: false });

        if (resultsError) throw resultsError;

        if (!results || results.length === 0) {
          setDiagnoses([]);
          setFilteredDiagnoses([]);
          setLoading(false);
          return;
        }

        // ユーザー情報を取得
        const userIds = [...new Set(results.map((r) => r.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, email, display_name')
          .in('id', userIds);

        const profileMap = new Map(
          (profiles || []).map((p) => [p.id, { email: p.email, display_name: p.display_name }])
        );

        const diagnosesWithUsers: DiagnosisWithUser[] = results.map((r) => {
          const profile = profileMap.get(r.user_id);
          return {
            ...r,
            user_email: profile?.email || '不明',
            user_display_name: profile?.display_name || null,
          };
        });

        setDiagnoses(diagnosesWithUsers);
        setFilteredDiagnoses(diagnosesWithUsers);
      } catch (err) {
        console.error('Failed to fetch diagnoses:', err);
        setError('診断データの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchDiagnoses();
  }, [supabase]);

  // フィルタリング
  useEffect(() => {
    let filtered = diagnoses;

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.user_email.toLowerCase().includes(term) ||
          (d.user_display_name && d.user_display_name.toLowerCase().includes(term)) ||
          d.type_code.toLowerCase().includes(term)
      );
    }

    if (filterType) {
      filtered = filtered.filter((d) => d.type_code === filterType);
    }

    if (filterLevel) {
      filtered = filtered.filter((d) => d.consciousness_level === parseInt(filterLevel));
    }

    setFilteredDiagnoses(filtered);
    setCurrentPage(1);
  }, [searchTerm, filterType, filterLevel, diagnoses]);

  // タイプコードのユニークリスト
  const uniqueTypes = [...new Set(diagnoses.map((d) => d.type_code))].sort();

  const totalPages = Math.ceil(filteredDiagnoses.length / ITEMS_PER_PAGE);
  const paginatedDiagnoses = filteredDiagnoses.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  // タイプ別統計
  const typeStats = diagnoses.reduce<Record<string, number>>((acc, d) => {
    acc[d.type_code] = (acc[d.type_code] || 0) + 1;
    return acc;
  }, {});

  const levelStats = diagnoses.reduce<Record<number, number>>((acc, d) => {
    acc[d.consciousness_level] = (acc[d.consciousness_level] || 0) + 1;
    return acc;
  }, {});

  return (
    <AdminGuard>
      <Header />
      <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-purple-950 to-slate-900">
        <div className="container mx-auto px-4 py-8">
          {/* ヘッダー */}
          <div className="mb-8">
            <Link
              href="/admin"
              className="text-indigo-400 hover:text-indigo-300 text-sm mb-4 inline-block"
            >
              ← ダッシュボードに戻る
            </Link>
            <h1 className="text-4xl font-bold text-white">診断データ</h1>
            <p className="text-gray-400 mt-1">全ユーザーの診断結果を閲覧</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-300">
              {error}
            </div>
          )}

          {/* 統計サマリー */}
          {!loading && diagnoses.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <div className="bg-indigo-900/30 border border-indigo-700/50 rounded-lg p-4">
                <p className="text-gray-400 text-xs">総診断数</p>
                <p className="text-3xl font-bold text-white mt-1">{diagnoses.length}</p>
              </div>
              <div className="bg-purple-900/30 border border-purple-700/50 rounded-lg p-4">
                <p className="text-gray-400 text-xs">タイプ数</p>
                <p className="text-3xl font-bold text-white mt-1">{uniqueTypes.length}</p>
              </div>
              <div className="bg-pink-900/30 border border-pink-700/50 rounded-lg p-4">
                <p className="text-gray-400 text-xs">最多タイプ</p>
                <p className="text-2xl font-bold text-white mt-1">
                  {Object.entries(typeStats).sort(([, a], [, b]) => b - a)[0]?.[0] || '-'}
                </p>
              </div>
              <div className="bg-slate-900/30 border border-slate-700/50 rounded-lg p-4">
                <p className="text-gray-400 text-xs">平均レベル</p>
                <p className="text-3xl font-bold text-white mt-1">
                  {diagnoses.length > 0
                    ? (
                        diagnoses.reduce((sum, d) => sum + d.consciousness_level, 0) /
                        diagnoses.length
                      ).toFixed(1)
                    : '-'}
                </p>
              </div>
            </div>
          )}

          {/* レベル分布 */}
          {!loading && diagnoses.length > 0 && (
            <div className="bg-indigo-900/20 border border-indigo-700/50 rounded-lg p-6 mb-8">
              <h3 className="text-lg font-semibold text-white mb-4">意識レベル分布</h3>
              <div className="grid grid-cols-6 gap-2">
                {[1, 2, 3, 4, 5, 6].map((level) => {
                  const count = levelStats[level] || 0;
                  const percentage = diagnoses.length > 0 ? (count / diagnoses.length) * 100 : 0;
                  return (
                    <div key={level} className="text-center">
                      <div className="h-24 flex items-end justify-center mb-2">
                        <div
                          className="w-full max-w-[40px] bg-gradient-to-t from-indigo-600 to-purple-500 rounded-t"
                          style={{ height: `${Math.max(percentage, 5)}%` }}
                        ></div>
                      </div>
                      <p className="text-white font-semibold text-sm">Lv.{level}</p>
                      <p className="text-gray-400 text-xs">{count}件</p>
                      <p className="text-gray-500 text-xs">{percentage.toFixed(0)}%</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* フィルター */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <input
              type="text"
              placeholder="メール・名前・タイプで検索..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            >
              <option value="">全タイプ</option>
              {uniqueTypes.map((type) => (
                <option key={type} value={type}>
                  {type} ({typeStats[type]}件)
                </option>
              ))}
            </select>
            <select
              value={filterLevel}
              onChange={(e) => setFilterLevel(e.target.value)}
              className="px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            >
              <option value="">全レベル</option>
              {[1, 2, 3, 4, 5, 6].map((level) => (
                <option key={level} value={level}>
                  Lv.{level} {levelNames[level]} ({levelStats[level] || 0}件)
                </option>
              ))}
            </select>
          </div>

          {/* テーブル */}
          {loading ? (
            <div className="flex justify-center items-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            </div>
          ) : (
            <>
              <div className="bg-indigo-950/30 border border-indigo-700/50 rounded-lg overflow-hidden shadow-xl">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-indigo-950/50 border-b border-indigo-700/50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          ユーザー
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          タイプ
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          意識レベル
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          診断日
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-700/30">
                      {paginatedDiagnoses.length > 0 ? (
                        paginatedDiagnoses.map((d) => (
                          <tr key={d.id} className="hover:bg-indigo-900/20 transition-colors">
                            <td className="px-6 py-4">
                              <p className="text-sm text-gray-300 font-mono">{d.user_email}</p>
                              {d.user_display_name && (
                                <p className="text-xs text-gray-500">{d.user_display_name}</p>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-lg font-bold text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text">
                                {d.type_code}
                              </span>
                              <p className="text-xs text-gray-400">
                                {typeNames[d.type_code] || ''}
                              </p>
                            </td>
                            <td className="px-6 py-4">
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-900/50 text-indigo-300">
                                Lv.{d.consciousness_level} {levelNames[d.consciousness_level]}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-400">
                              {new Date(d.created_at).toLocaleDateString('ja-JP', {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={4} className="px-6 py-8 text-center text-gray-400">
                            診断データが見つかりません
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ページネーション */}
              {totalPages > 1 && (
                <div className="mt-6 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="px-4 py-2 bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    前へ
                  </button>
                  {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
                    let page: number;
                    if (totalPages <= 10) {
                      page = i + 1;
                    } else if (currentPage <= 5) {
                      page = i + 1;
                    } else if (currentPage >= totalPages - 4) {
                      page = totalPages - 9 + i;
                    } else {
                      page = currentPage - 4 + i;
                    }
                    return (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        className={`px-3 py-2 rounded transition-colors ${
                          currentPage === page
                            ? 'bg-indigo-600 text-white'
                            : 'bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300'
                        }`}
                      >
                        {page}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="px-4 py-2 bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    次へ
                  </button>
                </div>
              )}

              <div className="mt-4 text-center text-gray-400 text-sm">
                {filteredDiagnoses.length > 0 && (
                  <>
                    {(currentPage - 1) * ITEMS_PER_PAGE + 1}～
                    {Math.min(currentPage * ITEMS_PER_PAGE, filteredDiagnoses.length)}件を表示
                    (合計: {filteredDiagnoses.length}件)
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AdminGuard>
  );
}
