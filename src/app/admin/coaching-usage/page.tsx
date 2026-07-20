'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import Header from '@/components/Header';
import type {
  CoachingScopeCategory,
  CoachingScopeDecision,
} from '@/lib/coaching-scope';

type Overview = {
  totalRequests: number;
  blockedRequests: number;
  longMessageRequests: number;
  uniqueUsers: number;
};

type UserSummary = {
  userId: string;
  email: string;
  displayName: string | null;
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  longMessageRequests: number;
  attachmentRequests: number;
  lastRequestAt: string;
  lastBlockedAt: string | null;
};

type UsageEvent = {
  id: string;
  request_id: string;
  user_id: string;
  session_id: string | null;
  decision: CoachingScopeDecision;
  category: CoachingScopeCategory;
  matched_rule: string;
  message_chars: number;
  total_request_chars: number;
  line_count: number;
  is_long_message: boolean;
  attachment_count: number;
  provider_requested: boolean;
  created_at: string;
  email: string;
  displayName: string | null;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type UsageResponse = {
  overview: Overview;
  users: UserSummary[];
  userPagination: Pagination;
  events: UsageEvent[];
  eventPagination: Pagination;
};

const CATEGORY_LABELS: Record<CoachingScopeCategory, string> = {
  coaching: '本人の相談',
  conversation_followup: '会話の続き',
  writing_editing: '一般文章の作成・添削',
  marketing_content: '広告・集客コンテンツ',
  translation: '翻訳',
  external_research: '外部調査',
  image_generation: '画像生成',
  programming: 'プログラム作成',
  ambiguous: '判定保留（利用可）',
};

const EMPTY_PAGINATION: Pagination = {
  page: 1,
  limit: 20,
  total: 0,
  totalPages: 1,
};

export default function CoachingUsagePage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [userPagination, setUserPagination] =
    useState<Pagination>(EMPTY_PAGINATION);
  const [eventPagination, setEventPagination] =
    useState<Pagination>({ ...EMPTY_PAGINATION, limit: 50 });
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [decision, setDecision] = useState<CoachingScopeDecision | ''>('');
  const [category, setCategory] = useState<CoachingScopeCategory | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        userPage: String(userPagination.page),
        userLimit: String(userPagination.limit),
        eventPage: String(eventPagination.page),
        eventLimit: String(eventPagination.limit),
      });
      if (search) params.set('search', search);
      if (decision) params.set('decision', decision);
      if (category) params.set('category', category);

      const response = await fetch(
        `/api/admin/coaching-usage?${params.toString()}`,
        { cache: 'no-store' }
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'AI利用監査データを取得できませんでした');
      }

      const data = payload as UsageResponse;
      setOverview(data.overview);
      setUsers(data.users);
      setEvents(data.events);
      setUserPagination(data.userPagination);
      setEventPagination(data.eventPagination);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'AI利用監査データを取得できませんでした'
      );
    } finally {
      setLoading(false);
    }
  }, [
    category,
    decision,
    eventPagination.limit,
    eventPagination.page,
    search,
    userPagination.limit,
    userPagination.page,
  ]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setUserPagination((current) => ({ ...current, page: 1 }));
    setEventPagination((current) => ({ ...current, page: 1 }));
    setSearch(searchDraft.trim());
  };

  const updateDecision = (value: CoachingScopeDecision | '') => {
    setDecision(value);
    setEventPagination((current) => ({ ...current, page: 1 }));
  };

  const updateCategory = (value: CoachingScopeCategory | '') => {
    setCategory(value);
    setEventPagination((current) => ({ ...current, page: 1 }));
  };

  return (
    <AdminGuard>
      <Header />
      <main className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-sm text-gray-500">
                <Link href="/admin" className="hover:text-blue-600">
                  管理画面
                </Link>
                <span className="px-2">/</span>AI利用監査
              </p>
              <h1 className="text-3xl font-bold text-gray-900">
                AIコーチング利用監査
              </h1>
              <p className="mt-2 text-sm text-gray-600">
                利用回数、長文入力、用途外判定を利用者別に確認できます。入力本文はこの画面には保存しません。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadUsage()}
              disabled={loading}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            >
              再読み込み
            </button>
          </div>

          {error && (
            <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="総リクエスト" value={overview?.totalRequests ?? 0} />
            <Metric label="利用者数" value={overview?.uniqueUsers ?? 0} />
            <Metric
              label="用途外を制限"
              value={overview?.blockedRequests ?? 0}
              accent="red"
            />
            <Metric
              label="2,000字以上"
              value={overview?.longMessageRequests ?? 0}
              accent="amber"
            />
          </section>

          <section className="mb-8">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">
                  利用者別集計
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  全期間の利用状況です。
                </p>
              </div>
              <form onSubmit={applySearch} className="flex gap-2">
                <input
                  type="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="名前またはメール"
                  className="w-56 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
                <button
                  type="submit"
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  検索
                </button>
              </form>
            </div>

            <div className="overflow-x-auto border border-gray-200 bg-white">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-100 text-left text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-4 py-3">利用者</th>
                    <th className="px-4 py-3 text-right">総数</th>
                    <th className="px-4 py-3 text-right">利用可</th>
                    <th className="px-4 py-3 text-right">用途外</th>
                    <th className="px-4 py-3 text-right">長文</th>
                    <th className="px-4 py-3 text-right">画像添付</th>
                    <th className="px-4 py-3">最終利用</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {!loading && users.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                        該当する利用記録はありません。
                      </td>
                    </tr>
                  ) : (
                    users.map((user) => (
                      <tr key={user.userId} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">
                            {user.displayName || '名前未設定'}
                          </p>
                          <p className="text-xs text-gray-500">{user.email}</p>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">
                          {user.totalRequests}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {user.allowedRequests}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-red-600">
                          {user.blockedRequests}
                        </td>
                        <td className="px-4 py-3 text-right text-amber-700">
                          {user.longMessageRequests}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {user.attachmentRequests}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                          {formatDate(user.lastRequestAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <PaginationControls
              pagination={userPagination}
              onPage={(page) =>
                setUserPagination((current) => ({ ...current, page }))
              }
            />
          </section>

          <section>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">判定履歴</h2>
                <p className="mt-1 text-sm text-gray-500">
                  新しい判定から順に表示します。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={decision}
                  onChange={(event) =>
                    updateDecision(event.target.value as CoachingScopeDecision | '')
                  }
                  className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  aria-label="判定で絞り込む"
                >
                  <option value="">すべての判定</option>
                  <option value="allowed">利用可</option>
                  <option value="blocked">用途外</option>
                </select>
                <select
                  value={category}
                  onChange={(event) =>
                    updateCategory(event.target.value as CoachingScopeCategory | '')
                  }
                  className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  aria-label="分類で絞り込む"
                >
                  <option value="">すべての分類</option>
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="overflow-x-auto border border-gray-200 bg-white">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-100 text-left text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-4 py-3">日時</th>
                    <th className="px-4 py-3">利用者</th>
                    <th className="px-4 py-3">判定</th>
                    <th className="px-4 py-3">分類</th>
                    <th className="px-4 py-3 text-right">文字数</th>
                    <th className="px-4 py-3 text-right">行数</th>
                    <th className="px-4 py-3 text-right">画像</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {!loading && events.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                        該当する判定履歴はありません。
                      </td>
                    </tr>
                  ) : (
                    events.map((event) => (
                      <tr key={event.id} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                          {formatDate(event.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">
                            {event.displayName || '名前未設定'}
                          </p>
                          <p className="text-xs text-gray-500">{event.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <DecisionBadge decision={event.decision} />
                        </td>
                        <td className="px-4 py-3 text-gray-700" title={event.matched_rule}>
                          {CATEGORY_LABELS[event.category]}
                          {event.is_long_message && (
                            <span className="ml-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                              長文
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {event.message_chars.toLocaleString('ja-JP')}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {event.line_count.toLocaleString('ja-JP')}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {event.attachment_count}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <PaginationControls
              pagination={eventPagination}
              onPage={(page) =>
                setEventPagination((current) => ({ ...current, page }))
              }
            />
          </section>
        </div>
      </main>
    </AdminGuard>
  );
}

function Metric({
  label,
  value,
  accent = 'blue',
}: {
  label: string;
  value: number;
  accent?: 'blue' | 'red' | 'amber';
}) {
  const accentClass = {
    blue: 'border-blue-300 text-blue-700',
    red: 'border-red-300 text-red-700',
    amber: 'border-amber-300 text-amber-800',
  }[accent];

  return (
    <div className={`border-l-4 bg-white px-4 py-5 shadow-sm ${accentClass}`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-3xl font-bold text-gray-900">
        {value.toLocaleString('ja-JP')}
      </p>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: CoachingScopeDecision }) {
  return decision === 'blocked' ? (
    <span className="inline-block rounded bg-red-100 px-2 py-1 text-xs font-semibold text-red-700">
      用途外
    </span>
  ) : (
    <span className="inline-block rounded bg-green-100 px-2 py-1 text-xs font-semibold text-green-700">
      利用可
    </span>
  );
}

function PaginationControls({
  pagination,
  onPage,
}: {
  pagination: Pagination;
  onPage: (page: number) => void;
}) {
  if (pagination.totalPages <= 1) return null;

  return (
    <div className="mt-3 flex items-center justify-end gap-3 text-sm text-gray-600">
      <span>
        {pagination.total.toLocaleString('ja-JP')}件中 {pagination.page}/
        {pagination.totalPages}ページ
      </span>
      <button
        type="button"
        onClick={() => onPage(pagination.page - 1)}
        disabled={pagination.page <= 1}
        className="rounded border border-gray-300 bg-white px-3 py-1.5 hover:bg-gray-100 disabled:opacity-40"
      >
        前へ
      </button>
      <button
        type="button"
        onClick={() => onPage(pagination.page + 1)}
        disabled={pagination.page >= pagination.totalPages}
        className="rounded border border-gray-300 bg-white px-3 py-1.5 hover:bg-gray-100 disabled:opacity-40"
      >
        次へ
      </button>
    </div>
  );
}

function formatDate(value: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
