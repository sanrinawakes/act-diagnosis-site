import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { coachingSystemPrompt } from '@/data/coaching-system-prompt';
import {
  isAllowedImageType,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  stripAttachmentMarkdown,
  type InlineImageAttachment,
} from '@/lib/attachments';
import {
  buildGeminiParts,
  createJsonLineStream,
  generateCoachingText,
  getStreamHeaders,
} from '@/lib/coaching-gemini';

export const runtime = 'nodejs';

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
  attachments?: InlineImageAttachment[];
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
  const baseFreePrompt = `${coachingSystemPrompt}

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

${diagnosisCode ? `## クライアント診断情報\n\nクライアントの診断コード: ${diagnosisCode}\n\nこのコード情報を念頭に置きながら、クライアントに最適なコーチングを提供してください。` : ''}`;

  return baseFreePrompt;
}

export async function POST(request: NextRequest) {
  try {
    const body: RequestBody = await request.json();
    const { messages, diagnosisCode, email, attachments = [], stream = false } = body;

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided' },
        { status: 400 }
      );
    }

    const attachmentError = validateInlineAttachments(attachments);
    if (attachmentError) {
      return NextResponse.json({ error: attachmentError }, { status: 400 });
    }

    if (!email) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Get or create free user and check rate limit
    const { data: existingUser, error: selectError } = await supabase
      .from('free_users')
      .select('id, chat_count_today, last_chat_date')
      .eq('email', email)
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
          email,
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

    const lastUserMessage = messages[messages.length - 1];
    const lastUserText = stripAttachmentMarkdown(lastUserMessage.content);
    const lastUserParts = buildGeminiParts(lastUserText, attachments);
    const historyMessages = messages.slice(0, -1);

    const completeSuccessfulResponse = async () => {
      const newChatCount = chatCountToday + 1;
      await supabase
        .from('free_users')
        .update({
          chat_count_today: newChatCount,
          last_chat_date: today,
          updated_at: new Date().toISOString(),
        })
        .eq('email', email);

      return {
        remaining: Math.max(0, 3 - newChatCount),
      };
    };

    if (stream) {
      return new Response(
        createJsonLineStream({
          systemPrompt,
          historyMessages,
          lastUserParts,
          onDone: completeSuccessfulResponse,
        }),
        { headers: getStreamHeaders() }
      );
    }

    let assistantMessage: string;
    let usage;
    try {
      const result = await generateCoachingText({
        systemPrompt,
        historyMessages,
        lastUserParts,
      });
      assistantMessage = result.text;
      usage = result.usage;
    } catch (genErr) {
      const isTimeout =
        genErr instanceof Error && genErr.message === 'GEMINI_TIMEOUT';
      console.error('Free Gemini generation error:', genErr);
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

function validateInlineAttachments(attachments: InlineImageAttachment[]) {
  if (attachments.length > MAX_IMAGE_ATTACHMENTS) {
    return `画像は最大${MAX_IMAGE_ATTACHMENTS}枚まで添付できます。`;
  }

  for (const attachment of attachments) {
    if (!isAllowedImageType(attachment.mimeType)) {
      return '添付できる画像は JPG / PNG / WebP / GIF のみです。';
    }

    if (!attachment.data || base64ByteSize(attachment.data) > MAX_IMAGE_BYTES) {
      return '画像1枚あたりの上限は4MBです。';
    }
  }

  return '';
}

function base64ByteSize(base64: string) {
  const clean = base64.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}
