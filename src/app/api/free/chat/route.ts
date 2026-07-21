import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  coachingConversationPriorityPrompt,
  getCoachingSystemPrompt,
  getContextualizedPrompt,
} from '@/data/coaching-system-prompt';
import {
  stripAttachmentMarkdown,
  type ChatImageAttachment,
} from '@/lib/attachments';
import { createServerClient } from '@/lib/supabase-server';
import {
  resolveChatAttachments,
  validateChatAttachments,
} from '@/lib/server-chat-attachments';
import {
  buildGeminiParts,
  compactCoachingMessages,
  createJsonLineStream,
  generateCoachingText,
  getStreamHeaders,
} from '@/lib/coaching-gemini';

export const runtime = 'nodejs';
export const preferredRegion = 'hnd1';
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  messages: ChatMessage[];
  diagnosisCode?: string;
  email: string;
  attachments?: ChatImageAttachment[];
  stream?: boolean;
}

function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Free version coaching prompt with a light study-session guidance layer.
 */
function getFreeCoachingSystemPrompt(diagnosisCode?: string): string {
  const personalizedPrompt = diagnosisCode
    ? getContextualizedPrompt(diagnosisCode)
    : getCoachingSystemPrompt();
  const baseFreePrompt = `${personalizedPrompt}

---

## 無料版に関する重要なガイダンス

このユーザーは無料版の簡易診断（15問）を受けています。簡易版では意識レベル2段階しか判定できず、27種類の性格タイプ判定もできません。まず相談内容に真摯に答え、そのうえで必要な時だけ、フルテストや無料オンライン勉強会に短く触れてください。

### コーチング方針
- ユーザーの質問や悩みへの回答を最優先にする。
- 簡易版の限界を説明する時は、短く自然に伝える。
- フルテストや勉強会の案内は、本文の最後に1〜2文だけ添える。
- ユーザーが深刻に悩んでいる時は、案内より共感と整理を優先する。
- 同じ誘導文を毎回繰り返さない。

### フルテストについて触れる時の言い方
- 「簡易版なので大まかな傾向として見ています。フルテストでは、より具体的な行動パターンまで見やすくなります」
- 「ここはもう少し深掘りできます。フルテストの結果があると、今の悩みに対してさらに具体的に見立てられます」
- 「気になれば、無料オンライン勉強会でフルテストについて確認できます」

### 無料オンライン勉強会への誘導
- 誘導は自然な流れがある時だけ、最後に短く添える。
- 長い宣伝文、強い煽り、毎回同じ文章は禁止。
- ユーザーが「詳しく知りたい」「もっと診断したい」と言った時は、勉強会案内を少し丁寧にする。

### トーン
- 売り込みではなく、必要な情報をそっと添える。
- ユーザーが話し続けたくなる自然な温度感を守る。
- 返答の中心は、あくまでコーチング体験にする。

### 提案リンク
無料オンライン勉強会へは以下のURLで案内できます：
https://example.com/study-session

---

${coachingConversationPriorityPrompt}`;

  return baseFreePrompt;
}

export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();

  try {
    const body: RequestBody = await request.json();
    const { messages, diagnosisCode, email, attachments = [], stream = false } = body;
    const normalizedEmail =
      typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided' },
        { status: 400 }
      );
    }

    if (!Array.isArray(attachments)) {
      return NextResponse.json({ error: 'Invalid attachments format' }, { status: 400 });
    }
    const malformedAttachment = attachments.some((attachment) => {
      if (!attachment || typeof attachment !== 'object') return true;
      const candidate = attachment as unknown as Record<string, unknown>;
      const hasData = typeof candidate.data === 'string';
      const hasPath = typeof candidate.path === 'string';
      return (
        typeof candidate.name !== 'string' ||
        typeof candidate.mimeType !== 'string' ||
        hasData === hasPath
      );
    });
    if (malformedAttachment) {
      return NextResponse.json({ error: 'Invalid attachments format' }, { status: 400 });
    }

    const hasStoredAttachments = attachments.some(
      (attachment) => attachment && typeof attachment === 'object' && 'path' in attachment
    );
    let attachmentUserId: string | null = null;
    if (hasStoredAttachments) {
      const authClient = await createServerClient();
      const {
        data: { user },
      } = await authClient.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      if (
        !user.email ||
        user.email.toLowerCase() !== normalizedEmail
      ) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      attachmentUserId = user.id;
    }

    const attachmentError = validateChatAttachments(
      attachments,
      attachmentUserId
    );
    if (attachmentError) {
      return NextResponse.json({ error: attachmentError }, { status: 400 });
    }

    if (!normalizedEmail) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();
    const attachmentStartedAt = Date.now();
    let inlineAttachments;
    try {
      inlineAttachments = await withAttachmentTimeout(
        resolveChatAttachments(attachments, supabase),
        20000
      );
    } catch (error) {
      const timedOut =
        error instanceof Error && error.message === 'ATTACHMENT_LOAD_TIMEOUT';
      return NextResponse.json(
        {
          error: timedOut
            ? '画像の読み込みに時間がかかりすぎました。もう一度お試しください。'
            : '画像を読み込めませんでした。画像を選び直してください。',
        },
        { status: timedOut ? 504 : 502 }
      );
    }
    const attachmentMs = Date.now() - attachmentStartedAt;

    // Get or create free user and check rate limit
    const accountLookupStartedAt = Date.now();
    const { data: existingUser, error: selectError } = await supabase
      .from('free_users')
      .select('id, chat_count_today, last_chat_date')
      .eq('email', normalizedEmail)
      .single();

    const today = new Date().toISOString().split('T')[0];
    let chatCountToday = 0;

    if (selectError && selectError.code !== 'PGRST116') {
      console.error('Error checking free user:', selectError);
      return NextResponse.json(
        { error: 'Database error' },
        { status: 500 }
      );
    }

    if (!existingUser) {
      // Create new free user
      const { error: insertError } = await supabase
        .from('free_users')
        .insert({
          email: normalizedEmail,
          chat_count_today: 0,
          last_chat_date: today,
          diagnosis_completed: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error('Error creating free user:', insertError);
        return NextResponse.json(
          { error: 'Failed to initialize free user' },
          { status: 500 }
        );
      }

      chatCountToday = 0;
    } else {
      // Check if we need to reset the count (new day)
      if (existingUser.last_chat_date !== today) {
        chatCountToday = 0;
        // Reset the count for the new day
        await supabase
          .from('free_users')
          .update({
            chat_count_today: 0,
            last_chat_date: today,
          })
          .eq('id', existingUser.id);
      } else {
        chatCountToday = existingUser.chat_count_today;
      }
    }
    const accountLookupMs = Date.now() - accountLookupStartedAt;

    // Check rate limit (3 chats per day for free users)
    if (chatCountToday >= 3) {
      return NextResponse.json(
        {
          error: 'rate_limit',
          remaining: 0,
          message: '本日のAIコーチングの利用回数に達しました。明日以降にご利用いただくか、フル版をご利用ください。',
        },
        { status: 429 }
      );
    }

    // Build system prompt with sales layer
    const systemPrompt = getFreeCoachingSystemPrompt(diagnosisCode);

    const compactMessages = compactCoachingMessages(messages);
    const lastUserMessage = compactMessages[compactMessages.length - 1];
    const lastUserText = stripAttachmentMarkdown(lastUserMessage.content);
    const lastUserParts = buildGeminiParts(lastUserText, inlineAttachments);
    const historyMessages = compactMessages.slice(0, -1);
    const telemetry = {
      route: '/api/free/chat',
      requestId: randomUUID(),
      requestMessages: messages.length,
      compactMessages: compactMessages.length,
      historyMessages: historyMessages.length,
      attachments: inlineAttachments.length,
      lastUserChars: lastUserText.length,
      preStreamMs: Date.now() - requestStartedAt,
      attachmentMs,
      accountLookupMs,
    };

    const completeSuccessfulResponse = async () => {
      const { data: updatedUser, error: updateError } = await supabase
        .from('free_users')
        .update({
          chat_count_today: chatCountToday + 1,
          last_chat_date: today,
          updated_at: new Date().toISOString(),
        })
        .eq('email', normalizedEmail)
        .select('chat_count_today')
        .single();

      if (updateError || !updatedUser) {
        throw new Error(
          `FREE_CHAT_COUNT_UPDATE_FAILED: ${
            updateError?.message || 'updated row not found'
          }`
        );
      }

      return {
        remaining: Math.max(0, 3 - updatedUser.chat_count_today),
      };
    };

    if (stream) {
      return new Response(
        createJsonLineStream({
          systemPrompt,
          historyMessages,
          lastUserParts,
          onDone: completeSuccessfulResponse,
          telemetry,
        }),
        { headers: getStreamHeaders() }
      );
    }

    let assistantMessage: string;
    let usage;
    let completionStatus;
    let finishReason;
    try {
      const result = await generateCoachingText({
        systemPrompt,
        historyMessages,
        lastUserParts,
      });
      assistantMessage = result.text;
      usage = result.usage;
      completionStatus = result.completionStatus;
      finishReason = result.finishReason;
      console.info(
        JSON.stringify({
          event: 'chat_nonstream_done',
          ...telemetry,
          modelName: result.modelName,
          outputChars: assistantMessage.length,
          completionStatus,
          finishReason,
          usage,
        })
      );
    } catch (genErr) {
      const isTimeout =
        genErr instanceof Error && genErr.message === 'GEMINI_TIMEOUT';
      console.error(
        JSON.stringify({
          event: 'chat_nonstream_error',
          ...telemetry,
          error: genErr instanceof Error ? genErr.message : String(genErr),
        })
      );
      return NextResponse.json(
        {
          error: isTimeout
            ? '応答に時間がかかりすぎたため中断しました。もう一度お試しください。'
            : 'AIの応答生成に失敗しました。もう一度お試しください。',
        },
        { status: isTimeout ? 504 : 502 }
      );
    }

    const { remaining } = await completeSuccessfulResponse();

    return NextResponse.json({
      message: assistantMessage,
      remaining,
      completionStatus,
      finishReason,
      usage,
    });
  } catch (error) {
    console.error('Free chat API error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}

function withAttachmentTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('ATTACHMENT_LOAD_TIMEOUT')),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}
