'use client';

import { Suspense, useEffect, useRef, useState, useCallback, type ChangeEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { useSubscriptionGuard } from '@/hooks/useSubscriptionGuard';
import {
  appendAttachmentMarkdown,
  parseAttachmentMarkdown,
  stripAttachmentMarkdown,
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

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

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

type ChatClientFailureStage =
  | 'initialize_chat'
  | 'prepare_attachments'
  | 'save_user_message'
  | 'load_history'
  | 'connect_chat'
  | 'read_stream'
  | 'save_response';

type ClientChatFailurePayload = {
  stage: ChatClientFailureStage;
  sessionId: string;
  elapsedMs: number;
  hadPartialResponse: boolean;
  errorName: string;
  errorMessage: string;
};

const CHAT_RESPONSE_TIMEOUT_MS = 60000;
const CHAT_PERSIST_TIMEOUT_MS = 10000;
const CHAT_INITIALIZATION_TIMEOUT_MS = 12000;
const ATTACHMENT_PRIVACY_NOTICE =
  'クリップボタンを押して写真選択画面を開いただけでは、画像は送信されません。選んだ画像も、送信ボタンを押す前なら削除できます。';
const CHAT_BUSY_MESSAGE =
  'AIが前の返信を処理中です。完了すると送信できます。入力内容はこのまま残ります。';
const CHAT_NOT_READY_MESSAGE =
  'チャットを準備中です。数秒待ってからもう一度送信してください。';
const CHAT_API_MESSAGE_LIMIT = 24;
const CLIENT_CHAT_FAILURE_QUEUE_KEY = 'acti-client-chat-failure-queue';
const CLIENT_CHAT_FAILURE_QUEUE_LIMIT = 10;
const CHAT_PERSIST_RETRY_DELAYS_MS = [400, 1000];

const createTimeoutError = (message: string) =>
  new DOMException(message, 'AbortError');

const withTimeout = async <T,>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          onTimeout?.();
          reject(createTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const createMessageId = () =>
  globalThis.crypto?.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });

const postClientChatFailure = async (
  payload: ClientChatFailurePayload
): Promise<'sent' | 'retry' | 'drop'> => {
  try {
    const response = await fetch('/api/monitor/coaching/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify(payload),
    });

    if (response.ok) return 'sent';
    return response.status >= 500 || response.status === 429 ? 'retry' : 'drop';
  } catch {
    return 'retry';
  }
};

const readQueuedClientChatFailures = (): ClientChatFailurePayload[] => {
  try {
    const raw = window.localStorage.getItem(CLIENT_CHAT_FAILURE_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-CLIENT_CHAT_FAILURE_QUEUE_LIMIT) : [];
  } catch {
    return [];
  }
};

const queueClientChatFailure = (payload: ClientChatFailurePayload) => {
  try {
    const queue = [...readQueuedClientChatFailures(), payload].slice(
      -CLIENT_CHAT_FAILURE_QUEUE_LIMIT
    );
    window.localStorage.setItem(
      CLIENT_CHAT_FAILURE_QUEUE_KEY,
      JSON.stringify(queue)
    );
  } catch {
    // The live request already failed; storage may also be unavailable.
  }
};

const flushQueuedClientChatFailures = async () => {
  const queue = readQueuedClientChatFailures();
  if (queue.length === 0) return;

  window.localStorage.removeItem(CLIENT_CHAT_FAILURE_QUEUE_KEY);
  for (let index = 0; index < queue.length; index += 1) {
    const result = await postClientChatFailure(queue[index]);
    if (result === 'retry') {
      queue.slice(index).forEach(queueClientChatFailure);
      return;
    }
  }
};

const reportClientChatFailure = (params: {
  stage: ChatClientFailureStage;
  sessionId: string;
  elapsedMs: number;
  hadPartialResponse: boolean;
  error: unknown;
}) => {
  const error = params.error;
  const payload: ClientChatFailurePayload = {
    stage: params.stage,
    sessionId: params.sessionId,
    elapsedMs: params.elapsedMs,
    hadPartialResponse: params.hadPartialResponse,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
  };

  void postClientChatFailure(payload).then((result) => {
    if (result === 'retry') queueClientChatFailure(payload);
  });
};

function CoachingContent() {
  const { loading: subscriptionLoading, allowed } = useSubscriptionGuard();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [loading, setLoading] = useState(false);
  const [botDisabled, setBotDisabled] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [diagnosisCode, setDiagnosisCode] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [remainingChats, setRemainingChats] = useState<number | null>(null);
  const [chatLimit, setChatLimit] = useState<number>(50);
  const [rateLimitReached, setRateLimitReached] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingAttachmentsRef = useRef<PendingImageAttachment[]>([]);
  const sendInFlightRef = useRef(false);
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

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    const flushFailures = () => {
      void flushQueuedClientChatFailures();
    };

    flushFailures();
    window.addEventListener('online', flushFailures);
    return () => window.removeEventListener('online', flushFailures);
  }, []);

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach((attachment) => {
        URL.revokeObjectURL(attachment.previewUrl);
      });
    };
  }, []);

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

        const controller = new AbortController();
        const response = await withTimeout(
          fetch(`/api/chat/sessions?${params.toString()}`, {
            headers: { Authorization: `Bearer ${authSession.access_token}` },
            signal: controller.signal,
          }),
          CHAT_INITIALIZATION_TIMEOUT_MS,
          'チャット履歴の読み込みに時間がかかりすぎました。',
          () => controller.abort()
        );

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

      const response = await withTimeout(
        fetch('/api/chat/sessions', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authSession.access_token}`,
          },
          body: JSON.stringify({ session_id: sid, is_pinned: !isPinned }),
        }),
        CHAT_INITIALIZATION_TIMEOUT_MS,
        'ピン留めの更新に時間がかかりすぎました。'
      );
      if (!response.ok) throw new Error('ピン留めを更新できませんでした。');

      await fetchSidebarSessions(sidebarSearch, sidebarTab, sidebarPage);
    } catch (error) {
      console.error('Error pinning session:', error);
      setAttachmentError(
        error instanceof Error ? error.message : 'ピン留めを更新できませんでした。'
      );
    }
  };

  // ─── Sidebar: delete ───
  const handleDeleteSession = async (sid: string) => {
    try {
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();
      if (!authSession?.access_token) return;

      const response = await withTimeout(
        fetch('/api/chat/sessions', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authSession.access_token}`,
          },
          body: JSON.stringify({ session_id: sid }),
        }),
        CHAT_INITIALIZATION_TIMEOUT_MS,
        'チャット履歴の削除に時間がかかりすぎました。'
      );
      if (!response.ok) throw new Error('チャット履歴を削除できませんでした。');

      setConfirmDeleteId(null);

      // If we deleted the current session, start a new chat
      if (sid === sessionId) {
        router.push('/coaching');
      }

      await fetchSidebarSessions(sidebarSearch, sidebarTab, 1);
    } catch (error) {
      console.error('Error deleting session:', error);
      setAttachmentError(
        error instanceof Error ? error.message : 'チャット履歴を削除できませんでした。'
      );
    }
  };

  // ─── Sidebar: switch session ───
  const handleSessionClick = (sid: string) => {
    if (sid === sessionId) return;
    router.push(`/coaching?session=${sid}`);
  };

  // ─── Sidebar: new chat ───
  const handleNewChat = () => {
    router.push('/coaching?new=1');
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
      const initializationStartedAt = Date.now();
      try {
        const {
          data: { user },
        } = await withTimeout(
          supabase.auth.getUser(),
          CHAT_INITIALIZATION_TIMEOUT_MS,
          'ログイン状態の確認に時間がかかりすぎました。'
        );

        if (!user) {
          router.push('/login');
          return;
        }

        const sessionIdParam = searchParams.get('session');
        const forceNewSession = searchParams.get('new') === '1';
        const codeParam = searchParams.get('code');

        // サイト設定確認
        const { data: settings } = await withTimeout(
          supabase.from('site_settings').select('bot_enabled').single(),
          CHAT_INITIALIZATION_TIMEOUT_MS,
          'チャット設定の確認に時間がかかりすぎました。'
        );

        if (settings && !settings.bot_enabled) {
          setBotDisabled(true);
          setInitialized(true);
          return;
        }

        // 既存セッションを再開する場合
        if (sessionIdParam) {
          const { data: existingSession, error: sessionError } = await withTimeout(
            supabase
              .from('chat_sessions')
              .select('*')
              .eq('id', sessionIdParam)
              .eq('user_id', user.id)
              .single(),
            CHAT_INITIALIZATION_TIMEOUT_MS,
            'チャット履歴の確認に時間がかかりすぎました。'
          );

          if (sessionError || !existingSession) {
            console.error('Session not found');
            setInitialized(true);
            return;
          }

          setSessionId(existingSession.id);

          const { data: msgs, error: messagesError } = await withTimeout(
            supabase
              .from('chat_messages')
              .select('*')
              .eq('session_id', existingSession.id)
              .order('created_at', { ascending: true }),
            CHAT_INITIALIZATION_TIMEOUT_MS,
            'メッセージ履歴の読み込みに時間がかかりすぎました。'
          );

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
            const { data: diagnosis } = await withTimeout(
              supabase
                .from('diagnosis_results')
                .select('type_code, consciousness_level')
                .eq('id', existingSession.diagnosis_result_id)
                .single(),
              CHAT_INITIALIZATION_TIMEOUT_MS,
              '診断結果の読み込みに時間がかかりすぎました。'
            );

            if (diagnosis) {
              code = `${diagnosis.type_code}-${diagnosis.consciousness_level}`;
              setDiagnosisCode(code);
            }
          }
          if (!code && existingSession.title) {
            const titleCode = existingSession.title.match(/Coaching:\s*([A-Z]{3}-[1-6])/);
            if (titleCode?.[1]) {
              code = titleCode[1];
              setDiagnosisCode(code);
            }
          }

          setInitialized(true);
          return;
        }

        if (!forceNewSession && !codeParam) {
          const { data: latestSession } = await withTimeout(
            supabase
              .from('chat_sessions')
              .select('id')
              .eq('user_id', user.id)
              .order('last_message_at', { ascending: false, nullsFirst: false })
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
            CHAT_INITIALIZATION_TIMEOUT_MS,
            '最新チャットの確認に時間がかかりすぎました。'
          );

          if (latestSession?.id) {
            router.replace(`/coaching?session=${latestSession.id}`);
            return;
          }
        }

        // 新しいセッションを作成
        let code = codeParam;
        let diagnosisResultId: string | null = null;

        if (!code) {
          const { data: diagnosisData } = await withTimeout(
            supabase
              .from('diagnosis_results')
              .select('*')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .limit(1),
            CHAT_INITIALIZATION_TIMEOUT_MS,
            '診断結果の確認に時間がかかりすぎました。'
          );

          if (diagnosisData && diagnosisData.length > 0) {
            diagnosisResultId = diagnosisData[0].id;
            code = `${diagnosisData[0].type_code}-${diagnosisData[0].consciousness_level}`;
          }
        }

        setDiagnosisCode(code);

        const { data: session, error: sessionError } = await withTimeout(
          supabase
            .from('chat_sessions')
            .insert({
              user_id: user.id,
              diagnosis_result_id: diagnosisResultId,
              title: code ? `Coaching: ${code}` : 'Chat Session',
            })
            .select()
            .single(),
          CHAT_INITIALIZATION_TIMEOUT_MS,
          '新しいチャットの作成に時間がかかりすぎました。'
        );

        if (sessionError) throw sessionError;

        setSessionId(session.id);
        setInitialized(true);

        if (code) {
          await sendInitialMessage(session.id, code);
        }

        // Refresh sidebar to include the new session
        fetchSidebarSessions(sidebarSearch, sidebarTab, 1);
        router.replace(`/coaching?session=${session.id}`);
      } catch (err) {
        console.error('Chat initialization error:', err);
        reportClientChatFailure({
          stage: 'initialize_chat',
          sessionId: searchParams.get('session') || '',
          elapsedMs: Date.now() - initializationStartedAt,
          hadPartialResponse: false,
          error: err,
        });
        setAttachmentError(
          'チャットを準備できませんでした。入力はまだ送信されていません。画面を再読み込みしてください。'
        );
        setInitialized(true);
      }
    };

    initializeChat();
  }, [router, supabase, searchParams, isReady]);

  const sendInitialMessage = async (sid: string, code: string) => {
    try {
      const { error: systemMessageError } = await supabase
        .from('chat_messages')
        .insert({
          session_id: sid,
          role: 'system',
          content: `ACTIの結果: ${code}\nこのコードに基づいてパーソナライズされたコーチングを提供します。`,
        });
      if (systemMessageError) throw systemMessageError;

      const welcomeMsg: Message = {
        id: createMessageId(),
        role: 'assistant',
        content: `こんにちは！ACTIのコーチングへようこそ。\n\nあなたのタイプコード「${code}」に基づいて、パーソナライズされたコーチングを提供します。\n\n次のテーマについてお話しすることができます：\n・自己理解 - あなたのタイプの強みと課題\n・行動パターン - 日常での行動傾向\n・人間関係 - 対人スキルの向上\n・キャリア - 仕事での活躍方法\n・パーソナルグロース - 成長のステップ\n\n何について詳しく知りたいですか？`,
        createdAt: new Date().toISOString(),
      };

      setMessages([welcomeMsg]);

      await persistChatMessage({
        id: welcomeMsg.id,
        sessionId: sid,
        role: 'assistant',
        content: welcomeMsg.content,
        failureMessage: '最初のメッセージを保存できませんでした。',
      });

      const { error: activityError } = await supabase
        .from('chat_sessions')
        .update({
          last_message_at: new Date().toISOString(),
          message_count: 1,
        })
        .eq('id', sid);
      if (activityError) throw activityError;
    } catch (err) {
      console.error('Failed to send initial message:', err);
    }
  };

  const refreshSessionActivity = async (sid: string) => {
    const { count, error: countError } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sid);
    if (countError) throw countError;

    const updateData: { last_message_at: string; message_count?: number } = {
      last_message_at: new Date().toISOString(),
    };

    if (typeof count === 'number') {
      updateData.message_count = count;
    }

    const { error: updateError } = await supabase
      .from('chat_sessions')
      .update(updateData)
      .eq('id', sid);
    if (updateError) throw updateError;
  };

  const persistChatMessage = async (params: {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    failureMessage: string;
  }) => {
    let lastError: unknown = null;

    for (
      let attempt = 0;
      attempt <= CHAT_PERSIST_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        const { error } = await withTimeout(
          supabase.from('chat_messages').insert({
            id: params.id,
            session_id: params.sessionId,
            role: params.role,
            content: params.content,
          }),
          CHAT_PERSIST_TIMEOUT_MS,
          params.failureMessage
        );

        if (!error || error.code === '23505') return;
        lastError = error;
      } catch (error) {
        lastError = error;
      }

      if (attempt < CHAT_PERSIST_RETRY_DELAYS_MS.length) {
        await delay(CHAT_PERSIST_RETRY_DELAYS_MS[attempt]);
      }
    }

    console.error('Chat message persistence failed after retries:', lastError);
    throw new Error(params.failureMessage);
  };

  const loadApiMessages = async (
    sid: string,
    fallbackMessages: Message[],
    onFailure?: (error: unknown) => void
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> => {
    const fallback = fallbackMessages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    try {
      const { data, error } = await withTimeout(
        supabase
          .from('chat_messages')
          .select('role, content, created_at')
          .eq('session_id', sid)
          .in('role', ['user', 'assistant'])
          .order('created_at', { ascending: false })
          .limit(CHAT_API_MESSAGE_LIMIT),
        CHAT_PERSIST_TIMEOUT_MS,
        '会話履歴の読み込みに時間がかかりすぎました。'
      );

      if (error) throw error;

      const loaded = (data || [])
        .reverse()
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: String(message.content || ''),
        }))
        .filter((message) => message.content.trim());

      return loaded.length > 0 ? loaded : fallback;
    } catch (error) {
      console.warn('Failed to load persisted messages for chat API:', error);
      onFailure?.(error);
      return fallback;
    }
  };

  // Voice input (speech recognition)
  const handleVoiceInput = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const speechWindow = window as Window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SR =
      speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!SR) {
      alert('お使いのブラウザは音声入力に対応していません。Chromeをお使いください。');
      return;
    }
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.continuous = false;
    rec.interimResults = true;
    let finalTranscript = '';
    rec.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += transcript;
        else interim += transcript;
      }
      if (finalTranscript) {
        setInput((prev) => (prev.replace(/ 【入力中】.*$/, '') + ' ' + finalTranscript).trim());
        finalTranscript = '';
      } else if (interim) {
        setInput((prev) => prev.replace(/ 【入力中】.*$/, '') + ' 【入力中】' + interim);
      }
    };
    rec.onend = () => {
      setIsListening(false);
      setInput((prev) => prev.replace(/ 【入力中】.*$/, '').trim());
    };
    rec.onerror = () => {
      setIsListening(false);
      setInput((prev) => prev.replace(/ 【入力中】.*$/, '').trim());
    };
    recognitionRef.current = rec;
    rec.start();
    setIsListening(true);
  };

  // Voice output (text-to-speech)
  const handleSpeak = (messageId: string, text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      alert('お使いのブラウザは読み上げに対応していません。');
      return;
    }
    if (speakingMessageId === messageId) {
      window.speechSynthesis.cancel();
      setSpeakingMessageId(null);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => setSpeakingMessageId(null);
    utterance.onerror = () => setSpeakingMessageId(null);
    window.speechSynthesis.speak(utterance);
    setSpeakingMessageId(messageId);
  };

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
    const activeSessionId = sessionId;

    if (!messageText && attachmentsToSend.length === 0) return;
    if (loading || sendInFlightRef.current) {
      setAttachmentError(CHAT_BUSY_MESSAGE);
      return;
    }
    if (!initialized || !activeSessionId) {
      setAttachmentError(CHAT_NOT_READY_MESSAGE);
      return;
    }

    sendInFlightRef.current = true;
    setLoading(true);
    setAttachmentError(null);

    let shouldPersistFallback = false;
    let assistantMessageId: string | null = null;
    let assistantContent = '';
    let controller: AbortController | null = null;
    const sendStartedAt = Date.now();
    let failureStage: ChatClientFailureStage = 'save_user_message';
    let shouldReportFailure = true;

    try {
      const files = attachmentsToSend.map((attachment) => attachment.file);
      const apiContent = messageText || '添付画像について見てください。';
      let userVisibleContent = messageText || '画像を添付しました。';
      let userMessage: Message = {
        id: createMessageId(),
        role: 'user',
        content: userVisibleContent,
        createdAt: new Date().toISOString(),
      };
      const acceptUserMessage = (content: string) => {
        userVisibleContent = content;
        userMessage = { ...userMessage, content };
        setMessages((prev) => [...prev, userMessage]);
        setInput('');
        clearPendingAttachments(attachmentsToSend);
        shouldPersistFallback = true;
      };

      const persistUserMessage = async () => {
        await persistChatMessage({
          id: userMessage.id,
          sessionId: activeSessionId,
          role: 'user',
          content: userVisibleContent,
          failureMessage:
            'メッセージを保存できませんでした。入力内容は残っています。少し待ってから、もう一度お試しください。',
        });
      };

      let chatAttachments: StoredImageAttachmentReference[] = [];

      if (files.length === 0) {
        failureStage = 'save_user_message';
        await persistUserMessage();
        acceptUserMessage(userVisibleContent);
      }

      if (files.length > 0) {
        failureStage = 'prepare_attachments';
        const uploadedAttachments = await withTimeout(
          uploadChatImageAttachments(files),
          30000,
          '添付画像の準備に時間がかかりすぎました。もう一度お試しください。'
        );
        chatAttachments = uploadedAttachments.map((attachment) => {
          if (!attachment.path) {
            throw new Error('画像の保存先を確認できませんでした。');
          }
          return {
            name: attachment.name,
            mimeType: attachment.mimeType,
            path: attachment.path,
          };
        });
        userVisibleContent = appendAttachmentMarkdown(
          messageText || '画像を添付しました。',
          uploadedAttachments
        );
        userMessage = {
          ...userMessage,
          content: userVisibleContent,
        };
        failureStage = 'save_user_message';
        await persistUserMessage();
        acceptUserMessage(
          userVisibleContent
        );
      }

      failureStage = 'load_history';
      const apiMessages = await loadApiMessages(activeSessionId, [
        ...messages,
        { ...userMessage, content: apiContent },
      ], (historyError) => {
        reportClientChatFailure({
          stage: 'load_history',
          sessionId: activeSessionId,
          elapsedMs: Date.now() - sendStartedAt,
          hadPartialResponse: false,
          error: historyError,
        });
      });

      // クライアント側でも60秒で打ち切る。fetch開始からストリーム読み取り完了までを対象にし、
      // 途中で応答が止まっても「送信中…」が固着しないようにする。
      controller = new AbortController();
      failureStage = 'connect_chat';
      const response = await withTimeout(
        fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
          },
          body: JSON.stringify({
            sessionId: activeSessionId,
            messages: apiMessages,
            diagnosisCode,
            attachments: chatAttachments,
            stream: true,
          }),
          signal: controller.signal,
        }),
        CHAT_RESPONSE_TIMEOUT_MS,
        'AIへの接続に時間がかかりすぎました。もう一度お試しください。',
        () => controller?.abort()
      );

      if (response.status === 429) {
        const data = await response.json();
        setRateLimitReached(true);
        setRemainingChats(0);
        shouldReportFailure = false;
        throw new Error(data.error || '本日の利用上限に達しました。');
      }

      assistantMessageId = createMessageId();
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);

      failureStage = 'read_stream';
      const data = await withTimeout(
        readChatStream(response, (chunk) => {
          assistantContent += chunk;
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: assistantContent }
                : message
            )
          );
        }),
        CHAT_RESPONSE_TIMEOUT_MS,
        'AIの応答に時間がかかりすぎました。もう一度お試しください。',
        () => controller?.abort()
      );

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

      if (
        data.completionStatus &&
        data.completionStatus !== 'complete'
      ) {
        reportClientChatFailure({
          stage: 'read_stream',
          sessionId: activeSessionId,
          elapsedMs: Date.now() - sendStartedAt,
          hadPartialResponse: Boolean(assistantContent.trim()),
          error: new Error(
            `AI_COMPLETION_${String(data.completionStatus).toUpperCase()}`
          ),
        });
      }

      if (data.remaining !== undefined) setRemainingChats(data.remaining);
      if (data.limit !== undefined) setChatLimit(data.limit);

      try {
        failureStage = 'save_response';
        await persistChatMessage({
          id: assistantMessageId,
          sessionId: activeSessionId,
          role: 'assistant',
          content:
            assistantContent ||
            'すみません、応答に失敗しました。もう一度お試しください。',
          failureMessage: 'AI応答を履歴に保存できませんでした。',
        });

        await withTimeout(
          refreshSessionActivity(activeSessionId),
          CHAT_PERSIST_TIMEOUT_MS,
          'セッション情報の更新に時間がかかりすぎました。'
        );
      } catch (persistErr) {
        console.error('Failed to persist assistant message or session update:', persistErr);
        reportClientChatFailure({
          stage: 'save_response',
          sessionId: activeSessionId,
          elapsedMs: Date.now() - sendStartedAt,
          hadPartialResponse: Boolean(assistantContent.trim()),
          error: persistErr,
        });
      }

      // Refresh sidebar to update preview/count. Do not block the send button on sidebar refresh.
      fetchSidebarSessions(sidebarSearch, sidebarTab, sidebarPage);
    } catch (err) {
      console.error('Failed to send message:', err);
      if (shouldReportFailure) {
        reportClientChatFailure({
          stage: failureStage,
          sessionId: activeSessionId,
          elapsedMs: Date.now() - sendStartedAt,
          hadPartialResponse: Boolean(assistantContent.trim()),
          error: err,
        });
      }
      if (!shouldPersistFallback) {
        setAttachmentError(err instanceof Error ? err.message : '送信に失敗しました。');
        return;
      }
      controller?.abort();
      const errorMessage = getUserFacingChatError(err);
      const failContent =
        assistantContent.trim()
          ? `${assistantContent}\n\n（途中で接続が不安定になったため、ここで一度区切りました。続きが必要な場合は「続き」と送ってください。）`
          : errorMessage;
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
      // 失敗時もassistant行とセッション更新を保存し、再読込で履歴が消えたように見える状態を防ぐ。
      try {
        await persistChatMessage({
          id: assistantMessageId || createMessageId(),
          sessionId: activeSessionId,
          role: 'assistant',
          content: failContent,
          failureMessage: 'エラー応答を履歴に保存できませんでした。',
        });
        await withTimeout(
          refreshSessionActivity(activeSessionId),
          CHAT_PERSIST_TIMEOUT_MS,
          'セッション情報の更新に時間がかかりすぎました。'
        );
        fetchSidebarSessions(sidebarSearch, sidebarTab, sidebarPage);
      } catch (saveErr) {
        console.error('Failed to persist fallback message:', saveErr);
        reportClientChatFailure({
          stage: 'save_response',
          sessionId: activeSessionId,
          elapsedMs: Date.now() - sendStartedAt,
          hadPartialResponse: Boolean(assistantContent.trim()),
          error: saveErr,
        });
      }
    } finally {
      sendInFlightRef.current = false;
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
  const chatInputDisabled = !initialized || !sessionId;
  const sendButtonDisabled =
    loading ||
    chatInputDisabled ||
    (!input.trim() && pendingAttachments.length === 0);
  const sendButtonLabel = loading
    ? '送信中...'
    : chatInputDisabled
      ? '準備中...'
      : t('coaching.send');

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
          <div className="flex-1 overflow-y-auto" data-testid="sidebar-sessions">
            {sidebarLoading ? (
              <div className="flex justify-center py-6" data-testid="sidebar-loading">
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
                    data-session-id={s.id}
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
                  {message.role === 'assistant' && (
                    <button
                      type="button"
                      onClick={() => handleSpeak(message.id, stripAttachmentMarkdown(message.content))}
                      className="text-xs text-blue-500 hover:text-blue-700 mt-1 mr-2"
                      title={speakingMessageId === message.id ? '読み上げ停止' : '音声で聞く'}
                    >
                      {speakingMessageId === message.id ? '⏸ 停止' : '🔊 読み上げ'}
                    </button>
                  )}
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
                <div className="max-w-4xl mx-auto">
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
                  <p className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
                    {ATTACHMENT_PRIVACY_NOTICE}
                  </p>
                  {attachmentError && (
                    <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {attachmentError}
                    </p>
                  )}
                  {loading && input.trim() && (
                    <p className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
                      {CHAT_BUSY_MESSAGE}
                    </p>
                  )}
                  {chatInputDisabled && (
                    <p className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
                      {CHAT_NOT_READY_MESSAGE}
                    </p>
                  )}
                  <div className="flex flex-wrap sm:flex-nowrap gap-3 items-end">
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
                      disabled={loading || chatInputDisabled}
                      className="order-2 sm:order-none flex-shrink-0 p-3 rounded-lg bg-blue-100 hover:bg-blue-200 text-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="画像を選ぶ（選んだだけでは送信されません）"
                      aria-label="画像を選ぶ。選んだだけでは送信されません"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.586-6.586a4 4 0 10-5.657-5.657l-6.586 6.586a6 6 0 108.485 8.485L20.5 13" />
                      </svg>
                    </button>
                  <button
                    type="button"
                    onClick={handleVoiceInput}
                    disabled={loading || chatInputDisabled}
                    className={`order-2 sm:order-none flex-shrink-0 px-4 py-3 rounded-lg transition-colors ${isListening ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse' : 'bg-blue-100 hover:bg-blue-200 text-blue-600'} disabled:opacity-50 disabled:cursor-not-allowed`}
                    title={isListening ? '録音停止' : '音声入力'}
                    aria-label={isListening ? '録音停止' : '音声入力'}
                  >
                    {isListening ? '🛑' : '🎤'}
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
                    placeholder={t('coaching.placeholder')}
                    className="order-1 sm:order-none basis-full sm:basis-0 flex-1 min-w-0 min-h-24 max-h-48 bg-white border border-blue-200 text-base leading-relaxed text-gray-900 placeholder-gray-500 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all resize-y"
                    disabled={chatInputDisabled}
                  />
                  <button
                    type="button"
                    onClick={sendMessage}
                    disabled={sendButtonDisabled}
                    className="order-2 sm:order-none ml-auto sm:ml-0 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 disabled:cursor-not-allowed"
                  >
                    {sendButtonLabel}
                  </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  );
}

function getUserFacingChatError(error: unknown) {
  if (!(error instanceof Error) || !error.message) {
    return '送信に失敗しました。入力内容は保存されています。少し待ってから、もう一度送信してください。';
  }

  if (/Unauthorized|ログインが必要/.test(error.message)) {
    return 'ログイン状態を確認できませんでした。入力内容は保存されています。画面を再読み込みして、もう一度送信してください。';
  }

  if (/Failed to get response|Internal server error/.test(error.message)) {
    return 'サーバーから回答を受け取れませんでした。入力内容は保存されています。少し待ってから、もう一度送信してください。';
  }

  return error.message;
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
