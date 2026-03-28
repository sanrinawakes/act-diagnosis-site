'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { useSubscriptionGuard } from '@/hooks/useSubscriptionGuard';

interface ChatSession {
  id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  is_pinned: boolean;
  last_message_at: string | null;
  message_count: number;
  preview: string | null;
}

interface PaginatedResponse {
  sessions: ChatSession[];
  total: number;
  page: number;
  limit: number;
}

function HistoryContent() {
  const { loading: subscriptionLoading, allowed } = useSubscriptionGuard();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [filteredSessions, setFilteredSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'pinned'>('all');
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const limit = 20;

  const isReady = !subscriptionLoading && allowed;

  const fetchSessions = useCallback(
    async (searchQuery?: string, tab?: 'all' | 'pinned', pageNum?: number) => {
      try {
        setLoading(true);
        const {
          data: { session: authSession },
        } = await supabase.auth.getSession();

        if (!authSession?.access_token) {
          router.push('/login');
          return;
        }

        const params = new URLSearchParams();
        if (tab === 'pinned') {
          params.append('pinned', 'true');
        }
        if (searchQuery) {
          params.append('search', searchQuery);
        }
        params.append('page', (pageNum || 1).toString());
        params.append('limit', limit.toString());

        const response = await fetch(
          `/api/chat/sessions?${params.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${authSession.access_token}`,
            },
          }
        );

        if (!response.ok) {
          if (response.status === 401) {
            router.push('/login');
          }
          throw new Error('Failed to fetch sessions');
        }

        const data: PaginatedResponse = await response.json();
        setFilteredSessions(data.sessions);
        setTotalCount(data.total);
        setPage(pageNum || 1);
      } catch (error) {
        console.error('Error fetching sessions:', error);
      } finally {
        setLoading(false);
      }
    },
    [supabase, router]
  );

  useEffect(() => {
    if (!isReady) return;
    fetchSessions(searchTerm, activeTab, 1);
  }, [isReady, activeTab, fetchSessions, searchTerm]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchTerm(value);
      // Debounced search is handled by the dependency effect
    },
    []
  );

  const handleSessionClick = (sessionId: string) => {
    router.push(`/coaching?session=${sessionId}`);
  };

  const handlePin = async (sessionId: string, isPinned: boolean) => {
    try {
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();

      if (!authSession?.access_token) {
        router.push('/login');
        return;
      }

      const response = await fetch('/api/chat/sessions', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({
          session_id: sessionId,
          is_pinned: !isPinned,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update session');
      }

      // Refresh the list
      await fetchSessions(searchTerm, activeTab, page);
    } catch (error) {
      console.error('Error updating session:', error);
    }
  };

  const handleDelete = async (sessionId: string) => {
    try {
      setIsDeleting(true);
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();

      if (!authSession?.access_token) {
        router.push('/login');
        return;
      }

      const response = await fetch('/api/chat/sessions', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({
          session_id: sessionId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to delete session');
      }

      setConfirmDelete(null);
      // Refresh the list
      await fetchSessions(searchTerm, activeTab, 1);
    } catch (error) {
      console.error('Error deleting session:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePageChange = (newPage: number) => {
    fetchSessions(searchTerm, activeTab, newPage);
  };

  if (subscriptionLoading) {
    return (
      <AuthGuard>
        <Header />
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">読み込み中...</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (!allowed) {
    return null;
  }

  const totalPages = Math.ceil(totalCount / limit);

  return (
    <AuthGuard>
      <Header />
      <div className="min-h-screen bg-blue-50 py-8 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-3xl font-bold text-gray-900">チャット履歴</h1>
              <Link
                href="/coaching"
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors font-semibold"
              >
                新しいチャット
              </Link>
            </div>

            {/* Search Bar */}
            <div className="mb-6">
              <input
                type="text"
                placeholder="チャットを検索..."
                value={searchTerm}
                onChange={(e) => handleSearch(e.target.value)}
                className="w-full px-4 py-2 border border-blue-200 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50"
              />
            </div>

            {/* Tabs */}
            <div className="flex gap-4 border-b border-blue-200">
              <button
                onClick={() => setActiveTab('all')}
                className={`px-4 py-2 font-semibold border-b-2 transition-colors ${
                  activeTab === 'all'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-600 hover:text-blue-600'
                }`}
              >
                すべて
              </button>
              <button
                onClick={() => setActiveTab('pinned')}
                className={`px-4 py-2 font-semibold border-b-2 transition-colors ${
                  activeTab === 'pinned'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-600 hover:text-blue-600'
                }`}
              >
                ピン留め
              </button>
            </div>
          </div>

          {/* Sessions List */}
          <div className="space-y-3">
            {loading ? (
              <div className="flex justify-center py-8">
                <div className="flex flex-col items-center gap-4">
                  <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-400"></div>
                  <p className="text-gray-700">読み込み中...</p>
                </div>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="bg-white rounded-lg border border-blue-200 p-8 text-center">
                <p className="text-gray-600 mb-4">チャットがまだありません</p>
                <Link
                  href="/coaching"
                  className="inline-block px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                >
                  新しいチャットを始める
                </Link>
              </div>
            ) : (
              filteredSessions.map((session) => (
                <div
                  key={session.id}
                  className="bg-white rounded-lg border border-blue-200 p-4 hover:shadow-md transition-shadow flex items-center justify-between"
                >
                  {/* Session Info */}
                  <div
                    onClick={() => handleSessionClick(session.id)}
                    className="flex-1 cursor-pointer min-w-0"
                  >
                    <h3 className="font-semibold text-gray-900 truncate">
                      {session.title || session.preview || 'チャット'}
                    </h3>
                    {session.preview && session.title && (
                      <p className="text-sm text-gray-600 truncate mt-1">
                        {session.preview}
                      </p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      <span>{session.message_count}件のメッセージ</span>
                      <span>
                        {new Date(
                          session.last_message_at || session.created_at
                        ).toLocaleDateString('ja-JP')}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 ml-4">
                    {/* Pin Button */}
                    <button
                      onClick={() => handlePin(session.id, session.is_pinned)}
                      className="p-2 hover:bg-blue-50 rounded-lg transition-colors"
                      title={session.is_pinned ? 'ピン留めを解除' : 'ピン留め'}
                    >
                      <span
                        className={`text-lg ${
                          session.is_pinned
                            ? 'text-blue-500'
                            : 'text-gray-400'
                        }`}
                      >
                        ★
                      </span>
                    </button>

                    {/* Delete Button */}
                    {confirmDelete === session.id ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            handleDelete(session.id)
                          }
                          disabled={isDeleting}
                          className="px-3 py-1 bg-red-500 hover:bg-red-600 disabled:bg-gray-400 text-white text-sm rounded transition-colors"
                        >
                          削除
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          disabled={isDeleting}
                          className="px-3 py-1 bg-gray-300 hover:bg-gray-400 disabled:bg-gray-400 text-gray-900 text-sm rounded transition-colors"
                        >
                          キャンセル
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(session.id)}
                        className="px-3 py-1 text-red-500 hover:bg-red-50 text-sm rounded transition-colors"
                      >
                        削除
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-8 flex justify-center gap-2">
              <button
                onClick={() => handlePageChange(page - 1)}
                disabled={page === 1}
                className="px-4 py-2 bg-white border border-blue-200 text-gray-700 rounded-lg hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                前へ
              </button>

              <div className="flex items-center gap-2">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (page <= 3) {
                    pageNum = i + 1;
                  } else if (page >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = page - 2 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => handlePageChange(pageNum)}
                      className={`px-3 py-2 rounded-lg transition-colors ${
                        page === pageNum
                          ? 'bg-blue-500 text-white'
                          : 'bg-white border border-blue-200 text-gray-700 hover:bg-blue-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => handlePageChange(page + 1)}
                disabled={page === totalPages}
                className="px-4 py-2 bg-white border border-blue-200 text-gray-700 rounded-lg hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                次へ
              </button>
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  );
}

export default function HistoryPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">読み込み中...</p>
          </div>
        </div>
      }
    >
      <HistoryContent />
    </Suspense>
  );
}
