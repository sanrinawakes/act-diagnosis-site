/**
 * LINE Messaging API Webhook Endpoint
 *
 * Receives messages from LINE users, processes them through the ACT coaching AI,
 * and sends responses back via the LINE Reply API (free, no message count).
 *
 * Architecture:
 * 1. LINE sends webhook event → this endpoint
 * 2. Verify signature (HMAC-SHA256)
 * 3. For text messages: look up or create user in Supabase
 * 4. Load conversation history from Supabase
 * 5. Generate AI response via shared ai-coach module
 * 6. Save messages to Supabase
 * 7. Reply via LINE Reply API
 */

import { after, NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@supabase/supabase-js';
import {
  verifySignature,
  replyMessage,
  textMessage,
  type LineWebhookBody,
  type LineWebhookEvent,
} from '@/lib/line';
import { generateCoachingResponse } from '@/lib/ai-coach';
import {
  claimLineWebhookEvent,
  completeLineWebhookEvent,
  reserveLineMessageRate,
} from '@/lib/line-webhook-events';
import {
  classifyCoachingScope,
  COACHING_SCOPE_GUIDANCE,
} from '@/lib/coaching-scope';
import {
  buildMonthlyQuotaError,
  MONTHLY_COACHING_LIMIT,
  releaseMonthlyQuota,
  reserveMonthlyQuota,
  type MonthlyQuotaReservation,
} from '@/lib/coaching-quota';
import { getJapanMonthStartKey } from '@/lib/japan-date';
import { hasCoachingAccess } from '@/lib/coaching-access';

export const runtime = 'nodejs';
const MAX_LINE_MESSAGE_CHARS = 2000;

// Use service role client for LINE webhook (no user session)
function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createServerClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * GET - LINE webhook verification (just return 200)
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

/**
 * POST - Receive LINE webhook events
 */
export async function POST(request: NextRequest) {
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();
    const signature = request.headers.get('x-line-signature');

    if (!signature) {
      console.error('Missing x-line-signature header');
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
    }

    // Verify webhook signature
    const isValid = await verifySignature(rawBody, signature);
    if (!isValid) {
      console.error('Invalid LINE webhook signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Parse the webhook body
    const body: LineWebhookBody = JSON.parse(rawBody);

    const supabase = createAdminClient();
    const claimedEvents = [] as LineWebhookEvent[];
    for (const event of body.events) {
      if (await claimLineWebhookEvent({ supabaseAdmin: supabase, event })) {
        claimedEvents.push(event);
      }
    }

    // A reply token has a short lifetime, but LINE also retries if the webhook
    // blocks on model generation. `after` keeps the work attached to this
    // request while returning a prompt acknowledgement to LINE.
    after(async () => {
      for (const event of claimedEvents) {
        try {
          await processEvent(event);
          await completeLineWebhookEvent({
            supabaseAdmin: supabase,
            event,
            status: 'complete',
          });
        } catch (error) {
          console.error('LINE webhook event processing failed:', error);
          try {
            await completeLineWebhookEvent({
              supabaseAdmin: supabase,
              event,
              status: 'failed',
            });
          } catch (completionError) {
            console.error('LINE webhook event completion failed:', completionError);
          }
        }
      }
    });

    return NextResponse.json({ status: 'accepted' });
  } catch (error) {
    console.error('LINE webhook error:', error);
    // Always return 200 to LINE to prevent retries
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }
}

/**
 * Process an array of LINE webhook events
 */
/**
 * Process a single LINE webhook event
 */
async function processEvent(event: LineWebhookEvent): Promise<void> {
  // Only handle message events with text
  if (event.type !== 'message' || event.message?.type !== 'text') {
    // For follow events, send a welcome message
    if (event.type === 'follow') {
      await handleFollowEvent(event);
    }
    return;
  }

  const userId = event.source.userId;
  if (!userId) {
    console.error('No userId in event source');
    return;
  }

  const userText = event.message.text!;
  const replyToken = event.replyToken;

  if (userText.length > MAX_LINE_MESSAGE_CHARS) {
    await replyMessage(replyToken, [
      textMessage(
        `一度に送れる文章は${MAX_LINE_MESSAGE_CHARS}文字までです。内容を分けて送ってください。`
      ),
    ]);
    return;
  }

  let quotaReservation: MonthlyQuotaReservation | null = null;
  let profile: LineAccessProfile | null = null;
  let supabase: ReturnType<typeof createAdminClient> | null = null;

  try {
    supabase = createAdminClient();

    // This limits automated bursts before any history write or AI request.
    const rate = await reserveLineMessageRate({
      supabaseAdmin: supabase,
      lineUserId: userId,
    });
    if (!rate.allowed) {
      await replyMessage(replyToken, [
        textMessage(
          `短時間に連続して送信されています。${rate.retryAfterSeconds}秒ほど待ってから、もう一度お試しください。`
        ),
      ]);
      return;
    }

    // LINE must be linked to an ACTI account with a current AWAKES term. A
    // follow or message event is never evidence of paid membership.
    profile = await findLineProfile(supabase, userId);
    if (!profile || !hasCoachingAccess(profile)) {
      await replyMessage(replyToken, [
        textMessage(
          'このLINEアカウントでは、有効なAWAKES会員情報を確認できません。会員サイトのACTIをご利用ください。'
        ),
      ]);
      return;
    }

    // 2. Get or create active chat session for this LINE user
    const session = await getOrCreateChatSession(supabase, profile.id);

    // 3. Load recent conversation history (last 20 messages)
    const { data: recentMessages } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', session.id)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(20);

    const history = (recentMessages || []).map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    const scope = classifyCoachingScope({
      messages: [...history, { role: 'user', content: userText }],
    });

    // 4. Save user message to database
    await supabase.from('chat_messages').insert({
      session_id: session.id,
      role: 'user',
      content: userText,
    });

    if (scope.decision === 'blocked') {
      await supabase.from('chat_messages').insert({
        session_id: session.id,
        role: 'assistant',
        content: COACHING_SCOPE_GUIDANCE,
      });
      await replyMessage(replyToken, [textMessage(COACHING_SCOPE_GUIDANCE)]);
      return;
    }

    // LINE uses the same monthly allowance as the member site. The previous
    // burst-only limit left this provider path effectively unlimited.
    try {
      quotaReservation = await reserveMonthlyQuota({
        supabaseAdmin: supabase,
        userId: profile.id,
        requestId: event.webhookEventId || event.message.id || event.replyToken,
        periodStart: getJapanMonthStartKey(),
        limit: MONTHLY_COACHING_LIMIT,
      });
    } catch (quotaError) {
      console.error('LINE monthly quota reservation failed:', quotaError);
      await replyMessage(replyToken, [
        textMessage('利用回数を確認できませんでした。少し時間をおいて、もう一度お試しください。'),
      ]);
      return;
    }

    if (!quotaReservation.allowed) {
      await replyMessage(replyToken, [
        textMessage(buildMonthlyQuotaError(MONTHLY_COACHING_LIMIT)),
      ]);
      return;
    }

    // 5. Get diagnosis code if available
    const { data: diagnosisResult } = await supabase
      .from('diagnosis_results')
      .select('type_code')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const diagnosisCode = diagnosisResult?.type_code || null;

    // 6. Generate AI response
    const aiResponse = await generateCoachingResponse(
      userText,
      history,
      diagnosisCode
    );

    // 7. Save assistant message to database
    await supabase.from('chat_messages').insert({
      session_id: session.id,
      role: 'assistant',
      content: aiResponse,
    });

    // 8. Reply via LINE (free, no message count)
    await replyMessage(replyToken, [textMessage(aiResponse)]);
  } catch (error) {
    console.error('Error handling LINE message:', error);

    // Do not consume the monthly allowance when the response could not be
    // stored or delivered. The reservation is otherwise kept after success.
    if (quotaReservation?.reservedNow && profile && supabase) {
      try {
        await releaseMonthlyQuota({
          supabaseAdmin: supabase,
          userId: profile.id,
          requestId: event.webhookEventId || event.message?.id || event.replyToken,
          periodStart: getJapanMonthStartKey(),
          limit: MONTHLY_COACHING_LIMIT,
        });
      } catch (releaseError) {
        console.error('LINE monthly quota release failed:', releaseError);
      }
    }

    // Try to send an error message
    try {
      await replyMessage(replyToken, [
        textMessage(
          'すみません、現在応答に問題が発生しています。しばらくしてからもう一度お試しください。'
        ),
      ]);
    } catch (replyError) {
      console.error('Failed to send error reply:', replyError);
    }
  }
}

/**
 * Handle follow (friend add) event
 */
async function handleFollowEvent(event: LineWebhookEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  try {
    // Send welcome message
    await replyMessage(event.replyToken, [
      textMessage(
        `ACTIコーチングへようこそ！

こちらはACT（Awakening Consciousness Type）診断に基づく、AIコーチングBotです。

ご利用には、有効なAWAKES会員情報とACTIアカウントへのLINE連携が必要です。

会員情報を確認できない場合は、会員サイトのACTIをご利用ください。`
      ),
    ]);
  } catch (error) {
    console.error('Error handling follow event:', error);
  }
}

/**
 * Find a paid ACTI profile linked to this LINE user.
 * Never create or activate a profile from an inbound LINE event.
 */
type LineAccessProfile = {
  id: string;
  line_user_id: string;
  role: string | null;
  subscription_status: string | null;
  is_active: boolean | null;
  paid_test_credits: number | null;
  awakes_access_expires_at: string | null;
};

async function findLineProfile(
  supabase: ReturnType<typeof createAdminClient>,
  lineUserId: string
): Promise<LineAccessProfile | null> {
  const { data: existing, error } = await supabase
    .from('profiles')
    .select('id, line_user_id, role, subscription_status, is_active, paid_test_credits, awakes_access_expires_at')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (error) throw error;
  return existing as LineAccessProfile | null;
}

/**
 * Get or create an active chat session for a LINE user
 */
async function getOrCreateChatSession(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<{ id: string }> {
  // Find the most recent active session (created within last 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: existingSession } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('user_id', userId)
    .gte('updated_at', oneDayAgo)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (existingSession) {
    // Update the updated_at timestamp
    await supabase
      .from('chat_sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', existingSession.id);

    return existingSession;
  }

  // Create a new session
  const { data: newSession, error } = await supabase
    .from('chat_sessions')
    .insert({
      user_id: userId,
      title: 'LINE Chat',
    })
    .select('id')
    .single();

  if (error || !newSession) {
    throw new Error(`Failed to create chat session: ${error?.message}`);
  }

  return newSession;
}
