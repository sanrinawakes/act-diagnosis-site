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

このユーザーは無料版の診断を受けています。以下のようにコーチングを進めてください：

### 自然な提案タイミング
- 1～2回目の交換では、ユーザーの状況をしっかり理解することに集中してください
- 3回目以降の交換で、さらに深い診断が役立つことを自然に言及することができます
- ユーザーが制限や改善の可能性について質問した時に、フルテストについて提案することができます

### フルテストに関する自然な言及方法
ユーザーが下記のような状況の際に、「それはフルテスト（42問）を受けることで、より精度の高い診断が得られる可能性があります」と自然に提案してください：
- より詳細な分析を求めているとき
- 自分のレベルや成長に興味を持っているとき
- より多くのコーチング機会を希望しているとき

### 無料オンライン勉強会について
下記のように自然に提案してください：
- 「この簡易テストは15問だけの短縮版なので、もっと精度の高い診断を受けたい場合は、フルテスト（42問）を受けることをお勧めします」
- 「無料オンライン勉強会では、フルテスト（42問）にアクセスでき、さらに2週間のAIコーチング（無制限）が利用できます」
- 「フルバージョンでは、あなたの意識レベルについてより詳しく理解することで、さらに深い成長サポートが可能になります」

### トーン
- 決して押し付けにならないようにしてください
- あくまで「ユーザーの成長に役立つ情報」として提示します
- ユーザーの関心度を読み取り、興味があれば詳しく説明してください

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
