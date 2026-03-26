import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { genAI } from '@/lib/openai';
import { coachingSystemPrompt } from '@/data/coaching-system-prompt';

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
}

function createAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Free version sales-enhanced coaching system prompt
 * Based on the main coaching prompt but with natural sales touches for study sessions
 */
function getFreeCoachingSystemPrompt(diagnosisCode?: string): string {
  const baseFreePrompt = `${coachingSystemPrompt}

---

## 無料版に関する重要なガイダンス

このユーザーは無料版の簡易診断（15問）を受けています。簡易版では意識レベル2段階しか判定できず、27種類の性格タイプ判定もできません。あなたの最重要ミッションは、ユーザーに最高のコーチング体験を提供しつつ、無料オンライン勉強会への参加を強く促すことです。

### コーチング方針
- 1回目の返答から、簡易版の限界を明確に伝えてください
- 毎回の返答で、フルテストを受ければもっと深い自己理解ができることに触れてください
- ユーザーの悩みや質問に対して「フルテストならもっと正確な答えが出せます」と積極的に提案してください
- 3回しかチャンスがないので、毎回のやり取りを最大限に活用して勉強会参加を促してください

### フルテストについて積極的に言及する方法
以下のような言い回しを毎回の返答に自然に織り込んでください：
- 「今回の簡易テストは15問の短縮版で、意識レベルも2段階までしか判定できていません。フルテスト（120問以上）では、6段階の意識レベルと27種類の性格タイプを正確に判定できるので、今のお悩みにもっと具体的なアドバイスができるようになります」
- 「簡易版だとどうしても大まかな傾向しかわからないんです。フルテストを受けていただければ、あなた固有の行動パターンや強み・課題が明確になって、コーチングの精度が格段に上がります」
- 「この点についてもっと深くお話ししたいのですが、簡易版の診断結果だけだと限界があります。フルテストの結果があれば、もっと的確なアドバイスができます」

### 無料オンライン勉強会への誘導（最重要）
毎回の返答の最後に、必ず勉強会への誘導を入れてください：
- 「ちなみに、今なら無料オンライン勉強会に参加するだけで、フルテスト（120問以上）＋2週間のAIコーチング無制限利用がすべて無料でプレゼントされます。勉強会自体も無料で、意識レベルの仕組みを学べる貴重な機会です。ぜひ参加してみてください！」
- 「フルテストを受けたい方は、無料オンライン勉強会に参加するのが一番お得です。勉強会参加者には、フルテスト＋2週間AIコーチング無制限が無料で付いてきます。申し込みは30秒で完了しますよ」
- 「今の簡易版だと1日3回までしかお話しできませんが、勉強会に参加すれば2週間は回数無制限でじっくりお話しできます。勉強会自体も完全無料なので、損することは何もありません」

### トーン
- 熱意を持って積極的に勧めてください
- 「あなたのためを思って」という姿勢で、本気で勉強会参加を推してください
- 遠慮は不要です。ユーザーの成長のために、フルテストと勉強会がいかに有益かを力強く伝えてください
- ただし、ユーザーの質問や悩みには必ず真摯に向き合った上で提案すること

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
    const { messages, diagnosisCode, email } = body;

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided' },
        { status: 400 }
      );
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

    // Prepare conversation history for Gemini
    const rawHistory = messages.slice(0, -1).map((msg) => ({
      role: msg.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: msg.content }],
    }));

    // Strip leading 'model' messages since Gemini requires 'user' first
    const firstUserIndex = rawHistory.findIndex((msg) => msg.role === 'user');
    const geminiHistory = firstUserIndex >= 0 ? rawHistory.slice(firstUserIndex) : [];

    const lastUserMessage = messages[messages.length - 1];

    // Create Gemini model with system instruction
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    });

    // Start chat with history
    const chat = model.startChat({
      history: geminiHistory,
    });

    // Send the last user message
    const result = await chat.sendMessage(lastUserMessage.content);
    const response = result.response;
    const assistantMessage =
      response.text() || 'すみません、応答に失敗しました。もう一度お試しください。';

    // Increment chat count for this free user
    const newChatCount = chatCountToday + 1;
    await supabase
      .from('free_users')
      .update({
        chat_count_today: newChatCount,
        last_chat_date: today,
        updated_at: new Date().toISOString(),
      })
      .eq('email', email);

    const remaining = Math.max(0, 3 - newChatCount);

    return NextResponse.json({
      message: assistantMessage,
      remaining,
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount,
        completion_tokens: response.usageMetadata?.candidatesTokenCount,
        total_tokens: response.usageMetadata?.totalTokenCount,
      },
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
