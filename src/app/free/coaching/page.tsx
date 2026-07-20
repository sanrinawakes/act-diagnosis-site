'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import Header from '@/components/Header';
import {
  appendAttachmentMarkdown,
  parseAttachmentMarkdown,
  type StoredImageAttachmentReference,
} from '@/lib/attachments';
import {
  uploadChatImageAttachments,
  validatePendingImageFiles,
  type PendingImageAttachment,
} from '@/lib/client-attachments';
import { readChatStream } from '@/lib/chat-stream-client';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface RateLimitModal {
  isOpen: boolean;
}

export default function FreeCoachingPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState<string | null>(null);
  const [diagnosisCode, setDiagnosisCode] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [messagesUsedToday, setMessagesUsedToday] = useState(0);
  const [rateLimitModal, setRateLimitModal] = useState<RateLimitModal>({ isOpen: false });
  const [pendingAttachments, setPendingAttachments] = useState<PendingImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingAttachmentsRef = useRef<PendingImageAttachment[]>([]);

  const DAILY_MESSAGE_LIMIT = 3;
  const remainingMessages = DAILY_MESSAGE_LIMIT - messagesUsedToday;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach((attachment) => {
        URL.revokeObjectURL(attachment.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    const getUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      setEmail(user.email || null);

      const savedResult = localStorage.getItem('free_diagnosis_result');
      if (!savedResult) {
        router.push('/free/diagnosis');
        return;
      }

      try {
        const result = JSON.parse(savedResult);
        const code = `${result.typeCode}-${result.level}`;
        setDiagnosisCode(code);

        // Get messages used today from localStorage
        const today = new Date().toDateString();
        const lastDate = localStorage.getItem('free_coaching_last_date');
        let used = 0;

        if (lastDate === today) {
          used = parseInt(localStorage.getItem('free_coaching_used') || '0', 10);
        } else {
          localStorage.setItem('free_coaching_last_date', today);
          localStorage.setItem('free_coaching_used', '0');
        }

        setMessagesUsedToday(used);
        setInitialized(true);

        // Load welcome message
        const welcomeMsg: Message = {
          id: Date.now().toString(),
          role: 'assistant',
          content: `こんにちは！ACTIのAIコーチへようこそ。\n\nあなたのタイプコード「${code}」に基づいて、パーソナライズされたコーチングを提供します。\n\n次のテーマについてお話しすることができます：\n・自己理解 - あなたのタイプの強みと課題\n・行動パターン - 日常での行動傾向\n・人間関係 - 対人スキルの向上\n・キャリア - 仕事での活躍方法\n・パーソナルグロース - 成長のステップ\n\n何について詳しく知りたいですか？`,
          createdAt: new Date().toISOString(),
        };
        setMessages([welcomeMsg]);
      } catch (error) {
        console.error('Failed to parse diagnosis result:', error);
        router.push('/free/diagnosis');
      }
    };

    getUser();
  }, [router, supabase]);

  const handleAttachmentSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';

    if (files.length === 0) {
      return;
    }

    const validationError = validatePendingImageFiles(pendingAttachments.length, files);
    if (validationError) {
      setAttachmentError(validationError);
      return;
    }

    const nextAttachments = files.map((file) => ({
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${file.name}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }));

    setPendingAttachments((prev) => [...prev, ...nextAttachments]);
    setAttachmentError(null);
  };

  const removePendingAttachment = (attachmentId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((attachment) => attachment.id === attachmentId);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((attachment) => attachment.id !== attachmentId);
    });
    setAttachmentError(null);
  };

  const clearPendingAttachments = (attachmentsToClear = pendingAttachments) => {
    attachmentsToClear.forEach((attachment) => {
      URL.revokeObjectURL(attachment.previewUrl);
    });
    setPendingAttachments([]);
  };

  const sendMessage = async () => {
    const messageText = input.trim();
    const attachmentsToSend = pendingAttachments;
    if ((!messageText && attachmentsToSend.length === 0) || loading || !email || !diagnosisCode) return;

    // Check rate limit
    if (remainingMessages <= 0) {
      setRateLimitModal({ isOpen: true });
      return;
    }

    setLoading(true);
    setAttachmentError(null);
    let userMessageAdded = false;
    let assistantMessageId: string | null = null;
    let assistantContent = '';

    try {
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();

      if (attachmentsToSend.length > 0 && !authSession?.access_token) {
        throw new Error('ログイン状態を確認できませんでした。再ログインしてからお試しください。');
      }

      const files = attachmentsToSend.map((attachment) => attachment.file);
      const uploadedAttachments = await uploadChatImageAttachments(
        files,
        authSession?.access_token || ''
      );
      const chatAttachments: StoredImageAttachmentReference[] =
        uploadedAttachments.map((attachment) => {
          if (!attachment.path) {
            throw new Error('画像の保存先を確認できませんでした。');
          }
          return {
            name: attachment.name,
            mimeType: attachment.mimeType,
            path: attachment.path,
          };
        });
      const userVisibleContent = appendAttachmentMarkdown(
        messageText || '画像を添付しました。',
        uploadedAttachments
      );
      const apiContent = messageText || '添付画像について見てください。';
      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: userVisibleContent,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setInput('');
      clearPendingAttachments(attachmentsToSend);
      userMessageAdded = true;

      const response = await fetch('/api/free/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({
          email: email,
          diagnosisCode: diagnosisCode,
          messages: messages.concat({ ...userMessage, content: apiContent }),
          attachments: chatAttachments,
          stream: true,
        }),
      });

      if (response.status === 429) {
        // Rate limited
        await response.json();
        setRateLimitModal({ isOpen: true });
        setLoading(false);
        return;
      }

      assistantMessageId = (Date.now() + 1).toString();
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      const data = await readChatStream(response, (chunk, mode) => {
        assistantContent =
          mode === 'replace' ? chunk : assistantContent + chunk;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: assistantContent }
              : message
          )
        );
      });

      if (data.message && data.message !== assistantContent) {
        assistantContent = data.message;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: assistantContent }
              : message
          )
        );
      }

      const newUsed =
        data.remaining !== undefined
          ? DAILY_MESSAGE_LIMIT - data.remaining
          : messagesUsedToday + 1;
      setMessagesUsedToday(newUsed);
      localStorage.setItem('free_coaching_used', newUsed.toString());
    } catch (err) {
      console.error('Failed to send message:', err);
      if (!userMessageAdded) {
        setAttachmentError(err instanceof Error ? err.message : '送信に失敗しました。');
        return;
      }
      const failContent = 'すみません、応答に失敗しました。もう一度お試しください。';
      if (assistantMessageId) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: failContent }
              : message
          )
        );
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 2).toString(),
            role: 'assistant',
            content: failContent,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } finally {
      setLoading(false);
    }
  };

  if (!initialized) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Header />
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
          <p className="text-gray-700">読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen">
      <Header />

      <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
        <div className="flex flex-col flex-1">
          {/* Chat Header */}
          <div className="bg-white border-b border-blue-200 px-4 sm:px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900">AIコーチング</h1>
              {diagnosisCode && (
                <p className="text-blue-600 text-sm">タイプ: {diagnosisCode}</p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-sm font-semibold text-gray-700">
                  残り回数: <span className={`${remainingMessages > 0 ? 'text-blue-600' : 'text-red-600'}`}>{remainingMessages}</span>回
                </p>
              </div>
              <Link
                href="/free/results"
                className="text-sm px-3 py-2 text-gray-600 hover:text-gray-900 transition-colors"
              >
                結果を見る
              </Link>
            </div>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-gradient-to-b from-white to-blue-50">
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
                  {(() => {
                    const parsedMessage = parseAttachmentMarkdown(message.content);
                    return (
                      <>
                        {parsedMessage.text && (
                          <p className="text-sm sm:text-base leading-relaxed whitespace-pre-wrap">
                            {parsedMessage.text}
                          </p>
                        )}
                        {parsedMessage.attachments.length > 0 && (
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            {parsedMessage.attachments.map((attachment) => (
                              <a
                                key={attachment.url}
                                href={attachment.url}
                                target="_blank"
                                rel="noreferrer"
                                className="block overflow-hidden rounded-lg border border-white/60 bg-white/10"
                              >
                                <img
                                  src={attachment.url}
                                  alt={attachment.label || '添付画像'}
                                  className="h-28 w-full object-cover"
                                />
                              </a>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
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
          <div className="border-t border-blue-200 bg-white p-4 sm:p-6">
            <div className="max-w-4xl mx-auto">
              {remainingMessages <= 0 && (
                <div className="bg-gradient-to-r from-purple-50 to-pink-50 border-2 border-purple-300 text-gray-900 p-4 rounded-lg mb-4 text-center">
                  <p className="font-bold text-lg">本日の無料相談回数を使い切りました</p>
                  <p className="text-sm mt-2 text-gray-700">
                    無料勉強会に参加すれば、2週間AIコーチング無制限＋フルテスト（120問以上）がすべて無料！
                  </p>
                  <a
                    href="https://example.com/study-session"
                    className="inline-block mt-3 py-2 px-6 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold rounded-lg transition-all duration-300 shadow-lg text-sm"
                  >
                    無料勉強会に申し込む →
                  </a>
                </div>
              )}
              {pendingAttachments.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {pendingAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="relative h-20 w-20 overflow-hidden rounded-lg border border-blue-200 bg-blue-50"
                    >
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.file.name}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removePendingAttachment(attachment.id)}
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white"
                        title="添付を削除"
                        aria-label="添付を削除"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachmentError && (
                <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {attachmentError}
                </p>
              )}
              <div className="flex gap-3 items-end">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={handleAttachmentSelect}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading || remainingMessages <= 0}
                  className="flex-shrink-0 p-3 rounded-lg bg-blue-100 hover:bg-blue-200 text-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="画像を選ぶ（選んだだけでは送信されません）"
                  aria-label="画像を選ぶ。選んだだけでは送信されません"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.586-6.586a4 4 0 10-5.657-5.657l-6.586 6.586a6 6 0 108.485 8.485L20.5 13" />
                  </svg>
                </button>
                <textarea
                  rows={3}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    const nativeEvent = e.nativeEvent as KeyboardEvent;
                    const isComposing =
                      nativeEvent.isComposing || nativeEvent.keyCode === 229;
                    const isTouch =
                      typeof window !== 'undefined' &&
                      window.matchMedia('(pointer: coarse)').matches;

                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !isComposing &&
                      !isTouch
                    ) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder={
                    remainingMessages > 0
                      ? 'メッセージを入力...'
                      : '本日の相談回数が上限です'
                  }
                  className="flex-1 min-h-24 max-h-48 bg-white border border-blue-200 text-base leading-relaxed text-gray-900 placeholder-gray-500 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all resize-y disabled:bg-gray-100"
                  disabled={loading || remainingMessages <= 0}
                />
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={
                    loading || (!input.trim() && pendingAttachments.length === 0) || remainingMessages <= 0
                  }
                  className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 disabled:cursor-not-allowed"
                >
                  {loading ? '送信中...' : '送信'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Rate Limit Modal */}
      {rateLimitModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-8 max-w-lg w-full shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="text-center mb-4">
              <span className="inline-block bg-red-500 text-white text-sm font-bold px-4 py-1 rounded-full">期間限定・完全無料</span>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-3 text-center">
              もっと深い対話がしたくないですか？
            </h2>
            <p className="text-gray-700 mb-4 text-center">
              今日の無料相談3回分を使い切りました。でも、もっと自分を深く知りたいと思いませんか？
            </p>

            <div className="bg-purple-50 border-2 border-purple-300 rounded-xl p-5 mb-5">
              <h3 className="font-bold text-purple-900 mb-3 text-center">無料勉強会に参加するだけで全部もらえる</h3>
              <div className="space-y-2 mb-4">
                <div className="flex gap-2 items-start">
                  <span className="text-green-500 text-lg flex-shrink-0">✓</span>
                  <p className="text-gray-700 text-sm"><span className="font-bold">フルテスト（120問以上）</span>で27種類の性格タイプ×6段階の意識レベルを正確判定</p>
                </div>
                <div className="flex gap-2 items-start">
                  <span className="text-green-500 text-lg flex-shrink-0">✓</span>
                  <p className="text-gray-700 text-sm"><span className="font-bold">2週間AIコーチング無制限</span>で回数を気にせず毎日深い対話</p>
                </div>
                <div className="flex gap-2 items-start">
                  <span className="text-green-500 text-lg flex-shrink-0">✓</span>
                  <p className="text-gray-700 text-sm"><span className="font-bold">勉強会で意識レベルの仕組みを学べる</span>から診断結果の理解が深まる</p>
                </div>
                <div className="flex gap-2 items-start">
                  <span className="text-green-500 text-lg flex-shrink-0">✓</span>
                  <p className="text-gray-700 text-sm"><span className="font-bold">すべて完全無料</span>。費用は一切かかりません</p>
                </div>
              </div>
            </div>

            {/* Testimonial */}
            <div className="bg-gray-50 rounded-lg p-4 mb-5 border border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 bg-pink-100 rounded-full flex items-center justify-center text-pink-600 font-bold text-xs">M</div>
                <p className="font-semibold text-gray-900 text-xs">M.K. さん（30代・女性）</p>
              </div>
              <p className="text-gray-700 text-xs leading-relaxed">「簡易版ではレベル2だったのが、フルテストではレベル3・SMA型と判明。AIコーチとの深い対話で人間関係が劇的に改善しました！」</p>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => {
                  window.location.href = 'https://example.com/study-session';
                }}
                className="w-full py-4 px-6 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold rounded-lg transition-all duration-300 shadow-lg text-lg animate-pulse"
              >
                無料勉強会に今すぐ申し込む →
              </button>
              <p className="text-center text-xs text-gray-500">※ 申し込みは30秒で完了します</p>
              <button
                onClick={() => setRateLimitModal({ isOpen: false })}
                className="w-full py-2 px-6 text-gray-400 text-sm hover:text-gray-500 transition-all duration-300"
              >
                明日また来る
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
