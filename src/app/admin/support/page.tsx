'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { splitSupportMessage } from '@/lib/support-reply-log';

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
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState('');
  const [replySuccess, setReplySuccess] = useState('');
  const supabase = createClient();
  const selectedMessage = selectedTicket
    ? splitSupportMessage(selectedTicket.message || '')
    : null;

  useEffect(() => {
    fetchTickets();
  }, [statusFilter]);

  useEffect(() => {
    if (!selectedTicket) {
      return;
    }

    setReplySubject(
      selectedTicket.subject.startsWith('Re:')
        ? selectedTicket.subject
        : `Re: ${selectedTicket.subject}`
    );
    setReplyBody('');
    setReplyError('');
    setReplySuccess('');
  }, [selectedTicket?.id]);

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

  const sendReply = async () => {
    if (!selectedTicket || replySending) {
      return;
    }

    const subject = replySubject.trim();
    const message = replyBody.trim();

    if (!subject || !message) {
      setReplyError('件名と本文を入力してください。');
      setReplySuccess('');
      return;
    }

    setReplySending(true);
    setReplyError('');
    setReplySuccess('');

    try {
      const response = await fetch('/api/admin/support/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ticket_id: selectedTicket.id,
          subject,
          message,
        }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.success || !result.ticket) {
        throw new Error(result.error || '返信の送信に失敗しました。');
      }

      const updatedTicket = result.ticket as SupportTicket;
      setTickets((prev) =>
        prev.map((ticket) => (ticket.id === updatedTicket.id ? updatedTicket : ticket))
      );
      setSelectedTicket(updatedTicket);
      setReplyBody('');
      setReplySuccess('返信を送信しました。');
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : '返信の送信に失敗しました。');
    } finally {
      setReplySending(false);
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
            <div className="flex flex-col lg:flex-row gap-6">
              {/* Ticket List */}
              <div className={`${selectedTicket ? 'lg:w-1/2' : 'w-full'} transition-all`}>
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
                <div className="lg:w-1/2">
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
                    <div className="mb-6 space-y-4">
                      <div>
                        <h3 className="text-sm font-semibold text-gray-700 mb-2">
                          問い合わせ内容
                        </h3>
                        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                          <p className="text-sm text-gray-900 whitespace-pre-wrap">
                            {selectedMessage?.customerMessage || selectedTicket.message}
                          </p>
                        </div>
                      </div>

                      {selectedMessage?.replyLog && (
                        <div>
                          <h3 className="text-sm font-semibold text-gray-700 mb-2">
                            返信履歴
                          </h3>
                          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                            <pre className="text-xs text-gray-900 whitespace-pre-wrap font-sans">
                              {selectedMessage.replyLog}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Reply */}
                    <div className="border-t border-gray-200 pt-5 mb-6">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">メール返信</h3>
                      <div className="space-y-3">
                        <input
                          type="text"
                          value={replySubject}
                          onChange={(e) => setReplySubject(e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-400/50"
                          placeholder="件名"
                        />
                        <textarea
                          rows={8}
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 leading-relaxed focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-400/50 resize-y"
                          placeholder="返信本文"
                        />
                        {replyError && (
                          <p className="text-sm text-red-600">{replyError}</p>
                        )}
                        {replySuccess && (
                          <p className="text-sm text-green-700">{replySuccess}</p>
                        )}
                        <button
                          type="button"
                          onClick={sendReply}
                          disabled={replySending || !replySubject.trim() || !replyBody.trim()}
                          className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
                        >
                          {replySending ? '送信中...' : '返信を送信'}
                        </button>
                      </div>
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
