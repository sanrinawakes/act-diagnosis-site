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

import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@supabase/supabase-js';
import {
  verifySignature,
  replyMessage,
  textMessage,
  type LineWebhookBody,
  type LineWebhookEvent,
} from '@/lib/line';
import { generateCoachingResponse } from '@/lib/ai-coach';

export const runtime = 'nodejs';

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

    // Process events asynchronously (return 200 immediately to LINE)
    // LINE expects a 200 response within 1 second, so we process in background
    const processingPromise = processEvents(body.events);

    // Wait for processing but don't block the response for too long
    // In serverless, we need to await since the function may be terminated after response
    await processingPromise;

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('LINE webhook error:', error);
    // Always return 200 to LINE to prevent retries
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }
}

/**
 * Process an array of LINE webhook events
 */
async function processEvents(events: LineWebhookEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await processEvent(event);
    } catch (error) {
      console.error('Error processing LINE event:', error);
    }
  }
}

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

  try {
    const supabase = createAdminClient();

    // 1. Find or create LINE-linked profile
    const profile = await getOrCreateLineProfile(supabase, userId);

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

    // 4. Save user message to database
    await supabase.from('chat_messages').insert({
      session_id: session.id,
      role: 'user',
      content: userText,
    });

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
    const supabase = createAdminClient();

    // Create profile for new LINE user
    await getOrCreateLineProfile(supabase, userId);

    // Send welcome message
    await replyMessage(event.replyToken, [
      textMessage(
        `ACT診断コーチングへようこそ！

こちらはACT（Awakening Consciousness Type）診断に基づく、AIコーチングBotです。

メッセージを送っていただければ、あなたのタイプに合わせたパーソナライズされたコーチングを提供します。

まずは何でもお気軽に話しかけてください。`
      ),
    ]);
  } catch (error) {
    console.error('Error handling follow event:', error);
  }
}

/**
 * Find or create a profile for a LINE user
 * Uses line_user_id column in profiles table
 */
async function getOrCreateLineProfile(
  supabase: ReturnType<typeof createAdminClient>,
  lineUserId: string
): Promise<{ id: string; line_user_id: string }> {
  // First, try to find existing profile with this LINE user ID
  const { data: existing } = await supabase
    .from('profiles')
    .select('id, line_user_id')
    .eq('line_user_id', lineUserId)
    .single();

  if (existing) {
    return existing;
  }

  // Create a new profile for this LINE user
  // Generate a deterministic UUID from the LINE user ID for the auth.users entry
  // We use the service role to create users directly
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email: `line_${lineUserId}@line.placeholder`,
    email_confirm: true,
    user_metadata: {
      provider: 'line',
      line_user_id: lineUserId,
    },
  });

  if (authError) {
    // If user already exists with this email, find them
    if (authError.message?.includes('already been registered')) {
      const { data: existingByEmail } = await supabase
        .from('profiles')
        .select('id, line_user_id')
        .eq('line_user_id', lineUserId)
        .single();

      if (existingByEmail) {
        return existingByEmail;
      }
    }
    throw new Error(`Failed to create auth user: ${authError.message}`);
  }

  // Update the profile with LINE user ID
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ line_user_id: lineUserId })
    .eq('id', authUser.user.id);

  if (profileError) {
    console.error('Failed to update profile with LINE user ID:', profileError);
  }

  return { id: authUser.user.id, line_user_id: lineUserId };
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
