'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import { createClient } from '@/lib/supabase';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

function ChatContent() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [botDisabled, setBotDisabled] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [diagnosisCode, setDiagnosisCode] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  // Auto-scroll to bottom when messages change
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Initialize chat
  useEffect(() => {
    const initializeChat = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          router.push('/login');
          return;
        }

        // Get diagnosis code from URL params
        const code = searchParams.get('code');
        setDiagnosisCode(code);

        // Check site settings
        const { data: settings, error: settingsError } = await supabase
          .from('site_settings')
          .select('bot_enabled')
          .single();

        if (settingsError) {
          console.error('Failed to fetch settings:', settingsError);
        } else if (settings && !settings.bot_enabled) {
          setBotDisabled(true);
          setInitialized(true);
          return;
        }

        // Create or get chat session
        const { data: session, error: sessionError } = await supabase
          .from('chat_sessions')
          .insert({
            user_id: user.id,
            diagnosis_result_id: code ? null : null,
            title: code ? `Coaching: ${code}` : 'Chat Session',
          })
          .select()
          .single();

        if (sessionError) throw sessionError;

        setSessionId(session.id);
        setInitialized(true);

        // Send initial system context if code is provided
        if (code) {
          sendInitialMessage(session.id, code, user.id);
        }
      } catch (err) {
        console.error('Chat initialization error:', err);
        setInitialized(true);
      }
    };

    initializeChat();
  }, [router, supabase, searchParams]);

  const sendInitialMessage = async (
    sid: string,
    code: string,
    userId: string
  ) => {
    try {
      const systemMessage = `ACTIの結果: ${code}

このコードに基づいてあなたの診断タイプと意識レベルを理解し、パーソナライズされたコーチングを提供します。`;

      // Save system message to database
      await supabase.from('chat_messages').insert({
        session_id: sid,
        role: 'system',
        content: systemMessage,
      });

      // Add welcome message
      const welcomeMsg = {
        id: Date.now().toString(),
        role: 'assistant' as const,
        content: `こんにちは！ACTIのコーチングへようこそ。

あなたのタイプコード「${code}」に基づいて、パーソナライズされたコーチングを提供します。

次のテーマについてお話しすることができます：
• 自己理解 - あなたのタイプの強みと課題
• 行動パターン - 日常での行動傾向
• 人間関係 - 対人スキルの向上
• キャリア - 仕事での活躍方法
• パーソナルグロース - 成長のステップ

何について詳しく知りたいですか？`,
        createdAt: new Date().toISOString(),
      };

      setMessages([welcomeMsg]);

      // Save to database
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
      // Save user message to database
      await supabase.from('chat_messages').insert({
        session_id: sessionId,
        role: 'user',
        content: input,
      });

      // Call chat API
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: messages.concat(userMessage),
          diagnosisCode,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to get response');
      }

      const data = await response.json();
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.message,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);

      // Save assistant message to database
      await supabase.from('chat_messages').insert({
        session_id: sessionId,
        role: 'assistant',
        content: data.message,
      });
    } catch (err) {
      console.error('Failed to send message:', err);
      const errorMessage: Message = {
        id: (Date.now() + 2).toString(),
        role: 'assistant',
        content:
          'すみません、応答に失敗しました。もう一度お試しください。',
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  if (!initialized) {
    return (
      <AuthGuard>
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            <p className="text-gray-300">読み込み中...</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 flex flex-col">
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-900 to-purple-900 border-b border-indigo-700/50 p-4 sm:p-6">
          <h1 className="text-2xl font-bold text-white">AIコーチング</h1>
          {diagnosisCode && (
            <p className="text-indigo-300 text-sm mt-1">
              タイプ: {diagnosisCode}
            </p>
          )}
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {botDisabled && (
            <div className="bg-yellow-900/30 border border-yellow-700 text-yellow-200 p-4 rounded-lg text-center">
              <p className="font-semibold">ボットは現在停止中です</p>
              <p className="text-sm mt-1">
                申し訳ございません。AIコーチングは現在利用できません。
              </p>
            </div>
          )}

          {messages.length === 0 && !botDisabled && (
            <div className="flex items-center justify-center h-full text-gray-400">
              <p>コーチングを開始しましょう</p>
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
                    ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white'
                    : 'bg-indigo-900/40 border border-indigo-700/50 text-gray-200'
                }`}
              >
                <p className="text-sm sm:text-base leading-relaxed">
                  {message.content}
                </p>
                <p
                  className={`text-xs mt-2 ${
                    message.role === 'user'
                      ? 'text-indigo-100'
                      : 'text-gray-400'
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
              <div className="bg-indigo-900/40 border border-indigo-700/50 text-gray-200 px-4 py-3 rounded-lg">
                <div className="flex gap-2">
                  <div className="h-2 w-2 bg-indigo-400 rounded-full animate-bounce"></div>
                  <div
                    className="h-2 w-2 bg-indigo-400 rounded-full animate-bounce"
                    style={{ animationDelay: '0.1s' }}
                  ></div>
                  <div
                    className="h-2 w-2 bg-indigo-400 rounded-full animate-bounce"
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
          <div className="border-t border-indigo-700/50 bg-indigo-900/20 p-4 sm:p-6">
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
                placeholder="メッセージを入力..."
                className="flex-1 bg-indigo-900/40 border border-indigo-700/50 text-white placeholder-gray-500 rounded-lg px-4 py-3 focus:outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-500/50 transition-all"
                disabled={loading}
              />
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {loading ? '送信中...' : '送信'}
              </button>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            <p className="text-gray-300">読み込み中...</p>
          </div>
        </div>
      }
    >
      <ChatContent />
    </Suspense>
  );
}
