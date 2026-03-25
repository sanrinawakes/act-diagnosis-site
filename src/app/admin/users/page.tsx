'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

interface UserWithDiagnosisCount extends Profile {
  diagnosis_count: number;
}

const ITEMS_PER_PAGE = 20;

export default function UserManagement() {
  const [users, setUsers] = useState<UserWithDiagnosisCount[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<UserWithDiagnosisCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchEmail, setSearchEmail] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [updating, setUpdating] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const supabase = createClient();

  // Fetch users on mount
  useEffect(() => {
    fetchUsers();
  }, []);

  // Filter users when search changes
  useEffect(() => {
    const filtered = users.filter((user) =>
      user.email.toLowerCase().includes(searchEmail.toLowerCase())
    );
    setFilteredUsers(filtered);
    setCurrentPage(1);
  }, [searchEmail, users]);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch all profiles
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (profilesError) throw profilesError;

      // For each user, fetch their diagnosis count
      const usersWithCounts = await Promise.all(
        (profiles || []).map(async (profile) => {
          const { count, error: countError } = await supabase
            .from('diagnosis_results')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', profile.id);

          if (countError) console.error('Error fetching diagnosis count:', countError);

          return {
            ...profile,
            diagnosis_count: count || 0,
          };
        })
      );

      setUsers(usersWithCounts as UserWithDiagnosisCount[]);
      setFilteredUsers(usersWithCounts as UserWithDiagnosisCount[]);
    } catch (err) {
      console.error('Failed to fetch users:', err);
      setError('ユーザー情報の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const toggleUserActive = async (userId: string, currentActive: boolean) => {
    try {
      setUpdating(userId);
      setError(null);

      const response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          is_active: !currentActive,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'ユーザー更新に失敗しました');
      }

      // Update local state
      setUsers((prevUsers) =>
        prevUsers.map((user) =>
          user.id === userId ? { ...user, is_active: !currentActive } : user
        )
      );

      setSuccessMessage(`ユーザーが${!currentActive ? '有効化' : '無効化'}されました`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      console.error('Failed to update user:', err);
      setError(err instanceof Error ? err.message : 'ユーザー更新に失敗しました');
    } finally {
      setUpdating(null);
    }
  };

  const toggleUserRole = async (userId: string, currentRole: string) => {
    if (
      !window.confirm(
        `${currentRole === 'admin' ? 'メンバー' : '管理者'}に変更してもよろしいですか？`
      )
    ) {
      return;
    }

    try {
      setUpdating(userId);
      setError(null);

      const newRole = currentRole === 'admin' ? 'member' : 'admin';

      const response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          role: newRole,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'ユーザー更新に失敗しました');
      }

      // Update local state
      setUsers((prevUsers) =>
        prevUsers.map((user) =>
          user.id === userId ? { ...user, role: newRole as 'admin' | 'member' } : user
        )
      );

      setSuccessMessage(
        `ユーザー役割が${newRole === 'admin' ? '管理者' : 'メンバー'}に変更されました`
      );
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      console.error('Failed to update user role:', err);
      setError(err instanceof Error ? err.message : '役割変更に失敗しました');
    } finally {
      setUpdating(null);
    }
  };

  const totalPages = Math.ceil(filteredUsers.length / ITEMS_PER_PAGE);
  const paginatedUsers = filteredUsers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  return (
    <AdminGuard>
      <Header />
      <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-purple-950 to-slate-900">
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <div className="mb-8 flex items-center justify-between">
            <div>
              <Link
                href="/admin"
                className="text-indigo-400 hover:text-indigo-300 text-sm mb-4 inline-block"
              >
                ← ダッシュボードに戻る
              </Link>
              <h1 className="text-4xl font-bold text-white">ユーザー管理</h1>
              <p className="text-gray-400 mt-1">登録ユーザーの管理と設定</p>
            </div>
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

          {/* Search Box */}
          <div className="mb-6">
            <input
              type="text"
              placeholder="メールアドレスで検索..."
              value={searchEmail}
              onChange={(e) => setSearchEmail(e.target.value)}
              className="w-full px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Loading State */}
          {loading && (
            <div className="flex justify-center items-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            </div>
          )}

          {/* Users Table */}
          {!loading && (
            <>
              <div className="bg-indigo-950/30 border border-indigo-700/50 rounded-lg overflow-hidden shadow-xl">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-indigo-950/50 border-b border-indigo-700/50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          メールアドレス
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          表示名
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          役割
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          ステータス
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          診断数
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          登録日
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-700/30">
                      {paginatedUsers.length > 0 ? (
                        paginatedUsers.map((user) => (
                          <tr
                            key={user.id}
                            className="hover:bg-indigo-900/20 transition-colors"
                          >
                            <td className="px-6 py-4 text-sm text-gray-300 font-mono">
                              {user.email}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-300">
                              {user.display_name || '未設定'}
                            </td>
                            <td className="px-6 py-4 text-sm">
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                  user.role === 'admin'
                                    ? 'bg-red-900/50 text-red-300'
                                    : 'bg-blue-900/50 text-blue-300'
                                }`}
                              >
                                {user.role === 'admin' ? '管理者' : 'メンバー'}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm">
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                  user.is_active
                                    ? 'bg-green-900/50 text-green-300'
                                    : 'bg-gray-900/50 text-gray-300'
                                }`}
                              >
                                {user.is_active ? '有効' : '無効'}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-300">
                              {user.diagnosis_count}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-400">
                              {new Date(user.created_at).toLocaleDateString('ja-JP')}
                            </td>
                            <td className="px-6 py-4 text-sm flex gap-2">
                              <button
                                onClick={() => toggleUserActive(user.id, user.is_active)}
                                disabled={updating === user.id}
                                className="px-2 py-1 rounded bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {user.is_active ? '無効化' : '有効化'}
                              </button>
                              <button
                                onClick={() => toggleUserRole(user.id, user.role)}
                                disabled={updating === user.id}
                                className="px-2 py-1 rounded bg-purple-900/50 hover:bg-purple-900 text-purple-300 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {user.role === 'admin' ? 'メンバーに' : '管理者に'}
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={7} className="px-6 py-8 text-center text-gray-400">
                            ユーザーが見つかりません
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-6 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="px-4 py-2 bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    前へ
                  </button>

                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
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
                  ))}

                  <button
                    onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="px-4 py-2 bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    次へ
                  </button>
                </div>
              )}

              {/* Summary */}
              <div className="mt-6 text-center text-gray-400 text-sm">
                {filteredUsers.length > 0 && (
                  <>
                    {(currentPage - 1) * ITEMS_PER_PAGE + 1}から
                    {Math.min(currentPage * ITEMS_PER_PAGE, filteredUsers.length)}件を表示
                    (合計: {filteredUsers.length}件)
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
