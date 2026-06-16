import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getContextualizedPrompt } from '@/data/coaching-system-prompt';
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
// Vercel関数のデフォルト打ち切り(Hobby 10s)を延長し、Gemini生成の途中切断を防ぐ
export const maxDuration = 60;

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
  attachments?: InlineImageAttachment[];
  stream?: boolean;
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
      .select('chat_count_today, last_chat_date, role, subscription_status, is_active, paid_test_credits')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('Profile fetch error:', profileError);
    }

    // 有料機能ガード（middleware.ts / useSubscriptionGuard.ts と同条件）。
    // 通常UIはmiddlewareで弾かれるが、APIを直接叩く経路の防御。
    if (profile && profile.role !== 'admin') {
      const hasActiveSubscription =
        profile.subscription_status === 'active' && profile.is_active;
      const hasPaidTestCredits = (profile.paid_test_credits || 0) > 0;
      if (!hasActiveSubscription && !hasPaidTestCredits) {
        return NextResponse.json(
          { error: '有料会員のみご利用いただけます。' },
          { status: 403 }
        );
      }
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
    const { messages, diagnosisCode, attachments = [], stream = false } = body;

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

    // Build system prompt
    const systemPrompt = diagnosisCode
      ? getContextualizedPrompt(diagnosisCode)
      : `You are an ACT (Awakening Consciousness Type) coaching AI designed to help users understand themselves better through personalized coaching.

You provide compassionate, insightful coaching based on the user's ACT type diagnosis. Your approach includes:
1. Deep empathy and understanding of the user's situation
2. Insightful observations about patterns and possibilities they might not see
3. Actionable next steps and practical suggestions

Always communicate in Japanese, with respect and curiosity. Help users understand their strengths, growth areas, and pathways to higher consciousness levels.`;

    const lastUserMessage = messages[messages.length - 1];
    const lastUserText = stripAttachmentMarkdown(lastUserMessage.content);
    const lastUserParts = buildGeminiParts(lastUserText, attachments);
    const historyMessages = messages.slice(0, -1);

    const completeSuccessfulResponse = async () => {
      const currentCount = profile && profile.last_chat_date === today ? (profile.chat_count_today || 0) : 0;
      const newCount = currentCount + 1;

      await supabaseAdmin
        .from('profiles')
        .update({
          chat_count_today: newCount,
          last_chat_date: today,
        })
        .eq('id', user.id);

      return {
        remaining: profile?.role === 'admin' ? DAILY_CHAT_LIMIT : Math.max(0, DAILY_CHAT_LIMIT - newCount),
        limit: DAILY_CHAT_LIMIT,
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
      console.error('Gemini generation error:', genErr);
      return NextResponse.json(
        {
          error: isTimeout
            ? '応答に時間がかかりすぎたため中断しました。もう一度お試しください。'
            : 'AIの応答生成に失敗しました。もう一度お試しください。',
        },
        { status: isTimeout ? 504 : 502 }
      );
    }

    // Increment daily chat count
    const { remaining, limit } = await completeSuccessfulResponse();

    return NextResponse.json({
      message: assistantMessage,
      remaining,
      limit,
      usage,
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
