'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { useSubscriptionGuard } from '@/hooks/useSubscriptionGuard';
import type { DiagnosisResult } from '@/lib/types';
import { typeNames } from '@/data/type-names';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

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

function CoachingContent() {
  const { loading: subscriptionLoading, allowed } = useSubscriptionGuard();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [botDisabled, setBotDisabled] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [diagnosisCode, setDiagnosisCode] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [latestDiagnosis, setLatestDiagnosis] = useState<DiagnosisResult | null>(null);
  const [remainingChats, setRemainingChats] = useState<number | null>(null);
  const [chatLimit, setChatLimit] = useState<number>(50);
  const [rateLimitReached, setRateLimitReached] = useState(false);

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSessions, setSidebarSessions] = useState<ChatSession[]>([]);
  const [sidebarLoading, setSidebarLoading] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [sidebarTab, setSidebarTab] = useState<'all' | 'pinned'>('all');
  const [sidebarPage, setSidebarPage] = useState(1);
  const [sidebarTotal, setSidebarTotal] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const { t } = useI18n();
  const sidebarLimit = 20;

  const isReady = !subscriptionLoading && allowed;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // ─── Sidebar: fetch sessions ───
  const fetchSidebarSessions = useCallback(
    async (search?: string, tab?: 'all' | 'pinned', pageNum?: number) => {
      try {
        setSidebarLoading(true);
        const {
          data: { session: authSession },
        } = await supabase.auth.getSession();

        if (!authSession?.access_token) return;

        const params = new URLSearchParams();
        if (tab === 'pinned') params.append('pinned', 'true');
        if (search) params.append('search', search);
        params.append('page', (pageNum || 1).toString());
        params.append('limit', sidebarLimit.toString());

        const response = await fetch(`/api/chat/sessions?${params.toString()}`, {
          headers: { Authorization: `Bearer ${authSession.access_token}` },
        });

        if (!response.ok) return;

        const data: PaginatedResponse = await response.json();
        setSidebarSessions(data.sessions);
        setSidebarTotal(data.total);
        setSidebarPage(pageNum || 1);
      } catch (error) {
        console.error('Error fetching sidebar sessions:', error);
      } finally {
        setSidebarLoading(false);
      }
    },
    [supabase]
  );

  // Fetch sidebar sessions on mount and when tab/search changes
  useEffect(() => {
    if (!isReady) return;
    fetchSidebarSessions(sidebarSearch, sidebarTab, 1);
  }, [isReady, sidebarTab, fetchSidebarSessions, sidebarSearch]);

  // ─── Sidebar: pin/unpin ───
  const handlePin = async (sid: string, isPinned: boolean) => {
    try {
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();
      if (!authSession?.access_token) return;

      await fetch('/api/chat/sessions', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({ session_id: sid, is_pinned: !isPinned }),
      });

      await fetchSidebarSessions(sidebarSearch, sidebarTab, sidebarPage);
    } catch (error) {
      console.error('Error pinning session:', error);
    }
  };

  // ─── Sidebar: delete ───
  const handleDeleteSession = async (sid: string) => {
    try {
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();
      if (!authSession?.access_token) return;

      await fetch('/api/chat/sessions', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({ session_id: sid }),
      });

      setConfirmDeleteId(null);

      // If we deleted the current session, start a new chat
      if (sid === sessionId) {
        router.push('/coaching');
      }

      await fetchSidebarSessions(sidebarSearch, sidebarTab, 1);
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  };

  // ─── Sidebar: switch session ───
  const handleSessionClick = (sid: string) => {
    if (sid === sessionId) return;
    router.push(`/coaching?session=${sid}`);
  };

  // ─── Sidebar: new chat ───
  const handleNewChat = () => {
    router.push('/coaching');
  };

  // ─── Hide sidebar on mobile by default ───
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)');
    if (mql.matches) setSidebarOpen(false);
  }, []);

  // ─── Chat initialization ───
  useEffect(() => {
    if (!isReady) return;

    const initializeChat = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          router.push('/login');
          return;
        }

        const sessionIdParam = searchParams.get('session');

        // サイト設定確認
        const { data: settings } = await supabase
          .from('site_settings')
          .select('bot_enabled')
          .single();

        if (settings && !settings.bot_enabled) {
          setBotDisabled(true);
          setInitialized(true);
          return;
        }

        // 既存セッションを再開する場合
        if (sessionIdParam) {
          const { data: existingSession, error: sessionError } = await supabase
            .from('chat_sessions')
            .select('*')
            .eq('id', sessionIdParam)
            .eq('user_id', user.id)
            .single();

          if (sessionError || !existingSession) {
            console.error('Session not found');
            setInitialized(true);
            return;
          }

          setSessionId(existingSession.id);

          const { data: msgs, error: messagesError } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('session_id', existingSession.id)
            .order('created_at', { ascending: true });

          if (messagesError) {
            console.error('Failed to load messages:', messagesError);
          } else if (msgs) {
            const loadedMessages = msgs
              .filter((m) => m.role !== 'system')
              .map((m) => ({
                id: m.id,
                role: m.role as 'user' | 'assistant',
                content: m.content,
                createdAt: m.created_at,
              }));
            setMessages(loadedMessages);
          }

          let code: string | null = null;
          if (existingSession.diagnosis_result_id) {
            const { data: diagnosis } = await supabase
              .from('diagnosis_results')
              .select('type_code, consciousness_level')
              .eq('id', existingSession.diagnosis_result_id)
              .single();

            if (diagnosis) {
              code = `${diagnosis.type_code}-${diagnosis.consciousness_level}`;
              setDiagnosisCode(code);
              setLatestDiagnosis(diagnosis as any);
            }
          }

          setInitialized(true);
          return;
        }

        // 新しいセッションを作成
        let code = searchParams.get('code');

        if (!code) {
          const { data: diagnosisData } = await supabase
            .from('diagnosis_results')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(1);

          if (diagnosisData && diagnosisData.length > 0) {
            setLatestDiagnosis(diagnosisData[0]);
            code = `${diagnosisData[0].type_code}-${diagnosisData[0].consciousness_level}`;
          }
        }

        setDiagnosisCode(code);

        const { data: session, error: sessionError } = await supabase
          .from('chat_sessions')
          .insert({
            user_id: user.id,
            diagnosis_result_id: null,
            title: code ? `Coaching: ${code}` : 'Chat Session',
          })
          .select()
          .single();

        if (sessionError) throw sessionError;

        setSessionId(session.id);
        setInitialized(true);

        if (code) {
          sendInitialMessage(session.id, code);
        }

        // Refresh sidebar to include the new session
        fetchSidebarSessions(sidebarSearch, sidebarTab, 1);
      } catch (err) {
        console.error('Chat initialization error:', err);
        setInitialized(true);
      }
    };

    initializeChat();
  }, [router, supabase, searchParams, isReady]);

  const sendInitialMessage = async (sid: string, code: string) => {
    try {
      await supabase.from('chat_messages').insert({
        session_id: sid,
        role: 'system',
        content: `ACTIの結果: ${code}\nこのコードに基づいてパーソナライズされたコーチングを提供します。`,
      });

      const welcomeMsg: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `こんにちは！ACTIのコーチングへようこそ。\n\nあなたのタイプコード「${code}」に基づいて、パーソナライズされたコーチングを提供します。\n\n次のテーマについてお話しすることができます：\n・自己理解 - あなたのタイプの強みと課題\n・行動パターン - 日常での行動傾向\n・人間関係 - 対人スキルの向上\n・キャリア - 仕事での活躍方法\n・パーソナルグロース - 成長のステップ\n\n何について詳しく知りたいですか？`,
        createdAt: new Date().toISOString(),
      };

      setMessages([welcomeMsg]);

      await supabase.from('chat_messages').insert({
        session_id: sid,
        role: 'assistant',
        content: welcomeMsg.content,
      });

      await supabase
        .from('chat_sessions')
        .update({
          last_message_at: new Date().toISOString(),
          message_count: 1,
        })
        .eq('id', sid);
    } catch (err) {
      console.error('Failed to send initial message:', err);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || loading || !sessionId) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      await supabase.from('chat_messages').insert({
        session_id: sessionId,
        role: 'user',
        content: input,
      });

      const { data: { session: authSession } } = await supabase.auth.getSession();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authSession?.access_token ? { 'Authorization': `Bearer ${authSession.access_token}` } : {}),
        },
        body: JSON.stringify({
          messages: messages.concat(userMessage),
          diagnosisCode,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 429) {
          setRateLimitReached(true);
          setRemainingChats(0);
          throw new Error(data.error || '本日の利用上限に達しました。');
        }
        throw new Error(data.error || 'Failed to get response');
      }

      if (data.remaining !== undefined) setRemainingChats(data.remaining);
      if (data.limit !== undefined) setChatLimit(data.limit);

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.message,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);

      await supabase.from('chat_messages').insert({
        session_id: sessionId,
        role: 'assistant',
        content: data.message,
      });

      const { data: sessionData } = await supabase
        .from('chat_sessions')
        .select('message_count')
        .eq('id', sessionId)
        .single();

      const currentCount = sessionData?.message_count || 0;

      await supabase
        .from('chat_sessions')
        .update({
          last_message_at: new Date().toISOString(),
          message_count: currentCount + 2,
        })
        .eq('id', sessionId);

      // Refresh sidebar to update preview/count
      fetchSidebarSessions(sidebarSearch, sidebarTab, sidebarPage);
    } catch (err) {
      console.error('Failed to send message:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 2).toString(),
          role: 'assistant',
          content: 'すみません、応答に失敗しました。もう一度お試しください。',
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // ─── Loading / Guard states ───
  if (subscriptionLoading) {
    return (
      <AuthGuard>
        <Header />
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">{t('common.loading')}</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (!allowed) return null;

  if (!initialized) {
    return (
      <AuthGuard>
        <Header />
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">{t('common.loading')}</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  const sidebarTotalPages = Math.ceil(sidebarTotal / sidebarLimit);

  return (
    <AuthGuard>
      <Header />
      <div className="flex" style={{ height: 'calc(100vh - 64px)' }}>
        {/* ━━━ Sidebar ━━━ */}
        <div
          className={`${
            sidebarOpen ? 'w-80' : 'w-0'
          } transition-all duration-300 overflow-hidden flex-shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col`}
          style={{ minWidth: sidebarOpen ? '320px' : '0px' }}
        >
          {/* Sidebar Header */}
          <div className="p-3 border-b border-gray-200 flex-shrink-0">
            <button
              onClick={handleNewChat}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors font-semibold text-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              新しいチャット
            </button>
          </div>

          {/* Search */}
          <div className="p-3 border-b border-gray-200 flex-shrink-0">
            <input
              type="text"
              placeholder="チャットを検索..."
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-400/50 bg-white"
            />
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-200 flex-shrink-0">
            <button
              onClick={() => setSidebarTab('all')}
              className={`flex-1 px-3 py-2 text-xs font-semibold border-b-2 transition-colors ${
                sidebarTab === 'all'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-blue-600'
              }`}
            >
              すべて
            </button>
            <button
              onClick={() => setSidebarTab('pinned')}
              className={`flex-1 px-3 py-2 text-xs font-semibold border-b-2 transition-colors ${
                sidebarTab === 'pinned'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-blue-600'
              }`}
            >
              ピン留め
            </button>
          </div>

          {/* Sessions List */}
          <div className="flex-1 overflow-y-auto">
            {sidebarLoading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-blue-400"></div>
              </div>
            ) : sidebarSessions.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-500">
                チャットがありません
              </div>
            ) : (
              <div className="py-1">
                {sidebarSessions.map((s) => (
                  <div
                    key={s.id}
                    className={`group relative px-3 py-2.5 cursor-pointer border-l-3 transition-colors ${
                      s.id === sessionId
                        ? 'bg-blue-100 border-l-blue-500'
                        : 'hover:bg-gray-100 border-l-transparent'
                    }`}
                    onClick={() => handleSessionClick(s.id)}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {s.title || s.preview || 'チャット'}
                        </p>
                        {s.preview && s.title && (
                          <p className="text-xs text-gray-500 truncate mt-0.5">
                            {s.preview}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1 text-xs text-gray-400">
                          <span>{s.message_count}件</span>
                          <span>
                            {new Date(s.last_message_at || s.created_at).toLocaleDateString('ja-JP', {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </span>
                        </div>
                      </div>

                      {/* Actions (visible on hover or when active) */}
                      <div className={`flex items-center gap-0.5 flex-shrink-0 ${s.id === sessionId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePin(s.id, s.is_pinned);
                          }}
                          className="p-1 hover:bg-blue-200 rounded transition-colors"
                          title={s.is_pinned ? 'ピン留めを解除' : 'ピン留め'}
                        >
                          <span className={`text-xs ${s.is_pinned ? 'text-blue-500' : 'text-gray-400'}`}>
                            {s.is_pinned ? '★' : '☆'}
                          </span>
                        </button>

                        {confirmDeleteId === s.id ? (
                          <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => handleDeleteSession(s.id)}
                              className="px-1.5 py-0.5 bg-red-500 text-white text-xs rounded hover:bg-red-600 transition-colors"
                            >
                              削除
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-1.5 py-0.5 bg-gray-300 text-gray-700 text-xs rounded hover:bg-gray-400 transition-colors"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(s.id);
                            }}
                            className="p-1 hover:bg-red-100 rounded transition-colors"
                            title="削除"
                          >
                            <svg className="w-3.5 h-3.5 text-gray-400 hover:text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Pagination */}
            {sidebarTotalPages > 1 && (
              <div className="flex justify-center gap-2 p-3 border-t border-gray-200">
                <button
                  onClick={() => fetchSidebarSessions(sidebarSearch, sidebarTab, sidebarPage - 1)}
                  disabled={sidebarPage === 1}
                  className="px-2 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  ←
                </button>
                <span className="px-2 py-1 text-xs text-gray-500">
                  {sidebarPage}/{sidebarTotalPages}
                </span>
                <button
                  onClick={() => fetchSidebarSessions(sidebarSearch, sidebarTab, sidebarPage + 1)}
                  disabled={sidebarPage === sidebarTotalPages}
                  className="px-2 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  →
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ━━━ Main Chat Area ━━━ */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat Header */}
          <div className="bg-white border-b border-blue-200 px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3">
              {/* Sidebar toggle button */}
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                title={sidebarOpen ? 'サイドバーを閉じる' : 'サイドバーを開く'}
              >
                <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {sidebarOpen ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  )}
                </svg>
              </button>
              <div>
                <h1 className="text-lg font-bold text-gray-900">{t('coaching.title')}</h1>
                {diagnosisCode && (
                  <p className="text-blue-600 text-xs">タイプ: {diagnosisCode}</p>
                )}
                {remainingChats !== null && (
                  <p className={`text-xs ${remainingChats <= 5 ? 'text-red-500 font-semibold' : 'text-gray-500'}`}>
                    残り: {remainingChats}/{chatLimit}回
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {!diagnosisCode && (
                <Link
                  href="/diagnosis"
                  className="text-sm px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                >
                  {t('coaching.takeDiagnosis')}
                </Link>
              )}
            </div>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
            {botDisabled && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-900 p-4 rounded-lg text-center">
                <p className="font-semibold">{t('coaching.botDisabled')}</p>
              </div>
            )}

            {messages.length === 0 && !botDisabled && !diagnosisCode && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="text-6xl mb-4">🤖</div>
                <p className="text-xl text-gray-900 mb-2">{t('coaching.title')}</p>
                <p className="text-gray-600 mb-6">
                  {t('coaching.noDiagnosis')}
                </p>
                <div className="flex gap-3">
                  <Link
                    href="/diagnosis"
                    className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                  >
                    {t('coaching.takeDiagnosis')}
                  </Link>
                </div>
              </div>
            )}

            {messages.length === 0 && !botDisabled && diagnosisCode && (
              <div className="flex items-center justify-center h-full text-gray-600">
                <p>コーチングを準備中...</p>
              </div>
            )}

            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-xs sm:max-w-md lg:max-w-lg px-4 py-3 rounded-lg ${
                    message.role === 'user'
                      ? 'bg-blue-500 text-white'
                      : 'bg-white border border-blue-200 text-gray-900'
                  }`}
                >
                  <p className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">
                    {message.content}
                  </p>
                  <p
                    className={`text-xs mt-2 ${
                      message.role === 'user' ? 'text-blue-100' : 'text-gray-500'
                    }`}
                  >
                    {new Date(message.createdAt).toLocaleTimeString('ja-JP', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-blue-200 text-gray-900 px-4 py-3 rounded-lg">
                  <div className="flex gap-2">
                    <div className="h-2 w-2 bg-blue-400 rounded-full animate-bounce"></div>
                    <div
                      className="h-2 w-2 bg-blue-400 rounded-full animate-bounce"
                      style={{ animationDelay: '0.1s' }}
                    ></div>
                    <div
                      className="h-2 w-2 bg-blue-400 rounded-full animate-bounce"
                      style={{ animationDelay: '0.2s' }}
                    ></div>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          {!botDisabled && (
            <div className="border-t border-blue-200 bg-white p-4 sm:p-6 flex-shrink-0">
              {rateLimitReached ? (
                <div className="max-w-4xl mx-auto text-center py-2">
                  <p className="text-red-600 font-semibold">本日の利用上限（{chatLimit}往復）に達しました。</p>
                  <p className="text-gray-500 text-sm mt-1">明日またご利用ください。</p>
                </div>
              ) : (
                <div className="max-w-4xl mx-auto flex gap-3">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder={t('coaching.placeholder')}
                    className="flex-1 bg-white border border-blue-200 text-gray-900 placeholder-gray-500 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all"
                    disabled={loading}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={loading || !input.trim()}
                    className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 disabled:cursor-not-allowed"
                  >
                    {loading ? '送信中...' : t('coaching.send')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  );
}

export default function CoachingPage() {
  const { t } = useI18n();

  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">{t('common.loading')}</p>
          </div>
        </div>
      }
    >
      <CoachingContent />
    </Suspense>
  );
}
