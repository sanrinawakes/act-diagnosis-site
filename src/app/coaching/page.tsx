'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const { t } = useI18n();

  // Wait for subscription check before initializing
  const isReady = !subscriptionLoading && allowed;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

        // URLパラメータから診断コードを取得、なければ最新の診断結果を使用
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

        // チャットセッション作成
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

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to get response');
      }

      const data = await response.json();
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

  if (!allowed) {
    return null;
  }

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

  return (
    <AuthGuard>
      <Header />
      <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
        <div className="flex flex-col flex-1">
          {/* チャットヘッダー */}
          <div className="bg-white border-b border-blue-200 px-4 sm:px-6 py-3 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900">{t('coaching.title')}</h1>
              {diagnosisCode && (
                <p className="text-blue-600 text-sm">タイプ: {diagnosisCode}</p>
              )}
            </div>
            {!diagnosisCode && (
              <Link
                href="/diagnosis"
                className="text-sm px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
              >
                {t('coaching.takeDiagnosis')}
              </Link>
            )}
          </div>

          {/* メッセージエリア */}
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

          {/* 入力エリア */}
          {!botDisabled && (
            <div className="border-t border-blue-200 bg-white p-4 sm:p-6">
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
