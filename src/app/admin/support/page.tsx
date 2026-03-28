'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';

interface SupportTicket {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const categoryLabels: Record<string, string> = {
  general: '一般',
  account: 'アカウント',
  billing: 'お支払い',
  bug: '不具合',
  feature: '機能リクエスト',
  other: 'その他',
};

const statusLabels: Record<string, string> = {
  open: '未対応',
  in_progress: '対応中',
  resolved: '解決済み',
  closed: 'クローズ',
};

const statusColors: Record<string, string> = {
  open: 'bg-red-100 text-red-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
  resolved: 'bg-green-100 text-green-700',
  closed: 'bg-gray-100 text-gray-600',
};

export default function AdminSupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const supabase = createClient();

  useEffect(() => {
    fetchTickets();
  }, [statusFilter]);

  const fetchTickets = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('support_tickets')
        .select('*')
        .order('created_at', { ascending: false });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;

      if (error) throw error;
      setTickets(data || []);
    } catch (error) {
      console.error('Failed to fetch tickets:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (ticketId: string, newStatus: string) => {
    try {
      const { error } = await supabase
        .from('support_tickets')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', ticketId);

      if (error) throw error;

      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t))
      );

      if (selectedTicket?.id === ticketId) {
        setSelectedTicket((prev) => (prev ? { ...prev, status: newStatus } : null));
      }
    } catch (error) {
      console.error('Failed to update ticket status:', error);
    }
  };

  return (
    <AdminGuard>
      <Header />
      <div className="min-h-screen">
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <Link href="/admin" className="text-blue-600 hover:text-blue-700 text-sm">
                  ← 管理画面
                </Link>
              </div>
              <h1 className="text-3xl font-bold text-gray-900">サポートチケット</h1>
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-2 mb-6 flex-wrap">
            {['all', 'open', 'in_progress', 'resolved', 'closed'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                  statusFilter === status
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {status === 'all' ? 'すべて' : statusLabels[status] || status}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-400"></div>
            </div>
          ) : tickets.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
              <p className="text-gray-500">チケットがありません</p>
            </div>
          ) : (
            <div className="flex gap-6">
              {/* Ticket List */}
              <div className={`${selectedTicket ? 'w-1/2' : 'w-full'} transition-all`}>
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600">ステータス</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600">カテゴリ</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600">件名</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600">送信者</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600">日時</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickets.map((ticket) => (
                        <tr
                          key={ticket.id}
                          onClick={() => setSelectedTicket(ticket)}
                          className={`border-b border-gray-100 cursor-pointer transition-colors ${
                            selectedTicket?.id === ticket.id
                              ? 'bg-blue-50'
                              : 'hover:bg-gray-50'
                          }`}
                        >
                          <td className="px-4 py-3">
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-semibold ${
                                statusColors[ticket.status] || 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {statusLabels[ticket.status] || ticket.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {categoryLabels[ticket.category] || ticket.category}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 font-medium truncate max-w-[200px]">
                            {ticket.subject}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">{ticket.name}</td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {new Date(ticket.created_at).toLocaleDateString('ja-JP', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Ticket Detail */}
              {selectedTicket && (
                <div className="w-1/2">
                  <div className="bg-white border border-gray-200 rounded-lg p-6 sticky top-20">
                    <div className="flex items-start justify-between mb-4">
                      <h2 className="text-lg font-bold text-gray-900">{selectedTicket.subject}</h2>
                      <button
                        onClick={() => setSelectedTicket(null)}
                        className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                      >
                        ×
                      </button>
                    </div>

                    <div className="space-y-3 mb-6">
                      <div className="flex gap-4 text-sm">
                        <span className="text-gray-500 w-20">送信者</span>
                        <span className="text-gray-900">{selectedTicket.name}</span>
                      </div>
                      <div className="flex gap-4 text-sm">
                        <span className="text-gray-500 w-20">メール</span>
                        <a
                          href={`mailto:${selectedTicket.email}`}
                          className="text-blue-600 hover:underline"
                        >
                          {selectedTicket.email}
                        </a>
                      </div>
                      <div className="flex gap-4 text-sm">
                        <span className="text-gray-500 w-20">カテゴリ</span>
                        <span className="text-gray-900">
                          {categoryLabels[selectedTicket.category] || selectedTicket.category}
                        </span>
                      </div>
                      <div className="flex gap-4 text-sm">
                        <span className="text-gray-500 w-20">日時</span>
                        <span className="text-gray-900">
                          {new Date(selectedTicket.created_at).toLocaleString('ja-JP')}
                        </span>
                      </div>
                    </div>

                    {/* Message */}
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
                      <p className="text-sm text-gray-900 whitespace-pre-wrap">
                        {selectedTicket.message}
                      </p>
                    </div>

                    {/* Status Update */}
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">
                        ステータス変更
                      </label>
                      <div className="flex gap-2 flex-wrap">
                        {Object.entries(statusLabels).map(([key, label]) => (
                          <button
                            key={key}
                            onClick={() => updateStatus(selectedTicket.id, key)}
                            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                              selectedTicket.status === key
                                ? 'bg-blue-500 text-white border-blue-500'
                                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AdminGuard>
  );
}
