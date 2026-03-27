import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { genAI } from '@/lib/openai';
import { getContextualizedPrompt } from '@/data/coaching-system-prompt';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const DAILY_CHAT_LIMIT = 50; // 1日50往復まで

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  messages: ChatMessage[];
  diagnosisCode?: string;
}

export async function POST(request: NextRequest) {
  try {
    // Verify user is authenticated via Authorization header
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized: No token provided' },
        { status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Service role client for rate limit updates (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Check daily chat limit
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('chat_count_today, last_chat_date, role')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('Profile fetch error:', profileError);
    }

    if (profile && profile.role !== 'admin') {
      const chatCountToday = profile.last_chat_date === today ? (profile.chat_count_today || 0) : 0;

      if (chatCountToday >= DAILY_CHAT_LIMIT) {
        return NextResponse.json(
          {
            error: `本日の利用上限（${DAILY_CHAT_LIMIT}往復）に達しました。明日またご利用ください。`,
            remaining: 0,
            limit: DAILY_CHAT_LIMIT,
          },
          { status: 429 }
        );
      }
    }

    // Check site settings
    const { data: settings, error: settingsError } = await supabase
      .from('site_settings')
      .select('bot_enabled')
      .single();

    if (settingsError) {
      console.error('Settings fetch error:', settingsError);
    }

    if (settings && !settings.bot_enabled) {
      return NextResponse.json(
        { error: 'Bot is currently disabled' },
        { status: 503 }
      );
    }

    const body: RequestBody = await request.json();
    const { messages, diagnosisCode } = body;

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided' },
        { status: 400 }
      );
    }

    // Build system prompt
    const systemPrompt = diagnosisCode
      ? getContextualizedPrompt(diagnosisCode)
      : `You are an ACT (Awakening Consciousness Type) coaching AI designed to help users understand themselves better through personalized coaching.

You provide compassionate, insightful coaching based on the user's ACT type diagnosis. Your approach includes:
1. Deep empathy and understanding of the user's situation
2. Insightful observations about patterns and possibilities they might not see
3. Actionable next steps and practical suggestions

Always communicate in Japanese, with respect and curiosity. Help users understand their strengths, growth areas, and pathways to higher consciousness levels.`;

    // Prepare conversation history for Gemini
    // Gemini requires the first message in history to be 'user' role
    const rawHistory = messages.slice(0, -1).map((msg) => ({
      role: msg.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: msg.content }],
    }));
    // Strip leading 'model' messages (e.g. welcome message) since Gemini requires 'user' first
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

    // Increment daily chat count
    const currentCount = profile && profile.last_chat_date === today ? (profile.chat_count_today || 0) : 0;
    const newCount = currentCount + 1;

    await supabaseAdmin
      .from('profiles')
      .update({
        chat_count_today: newCount,
        last_chat_date: today,
      })
      .eq('id', user.id);

    const remaining = profile?.role === 'admin' ? DAILY_CHAT_LIMIT : Math.max(0, DAILY_CHAT_LIMIT - newCount);

    return NextResponse.json({
      message: assistantMessage,
      remaining,
      limit: DAILY_CHAT_LIMIT,
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount,
        completion_tokens: response.usageMetadata?.candidatesTokenCount,
        total_tokens: response.usageMetadata?.totalTokenCount,
      },
    });
  } catch (error) {
    console.error('Chat API error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
