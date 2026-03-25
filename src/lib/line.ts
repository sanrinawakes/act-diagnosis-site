/**
 * LINE Messaging API utilities
 */

const LINE_API_BASE = 'https://api.line.me/v2/bot';

/**
 * Get LINE Channel Access Token from environment
 */
function getChannelAccessToken(): string {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Missing LINE_CHANNEL_ACCESS_TOKEN environment variable');
  }
  return token;
}

/**
 * Get LINE Channel Secret from environment
 */
export function getChannelSecret(): string {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    throw new Error('Missing LINE_CHANNEL_SECRET environment variable');
  }
  return secret;
}

/**
 * Verify LINE webhook signature
 * @param body - Raw request body as string
 * @param signature - X-Line-Signature header value
 * @returns true if signature is valid
 */
export async function verifySignature(
  body: string,
  signature: string
): Promise<boolean> {
  const secret = getChannelSecret();
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const digest = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return digest === signature;
}

/**
 * Reply to a LINE message using Reply API (free, no message count)
 * @param replyToken - Reply token from the webhook event
 * @param messages - Array of LINE message objects
 */
export async function replyMessage(
  replyToken: string,
  messages: LineMessage[]
): Promise<void> {
  const token = getChannelAccessToken();

  const response = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('LINE reply failed:', response.status, error);
    throw new Error(`LINE reply failed: ${response.status} ${error}`);
  }
}

/**
 * Push a message to a LINE user (counts toward message quota)
 * @param to - LINE user ID
 * @param messages - Array of LINE message objects
 */
export async function pushMessage(
  to: string,
  messages: LineMessage[]
): Promise<void> {
  const token = getChannelAccessToken();

  const response = await fetch(`${LINE_API_BASE}/message/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('LINE push failed:', response.status, error);
    throw new Error(`LINE push failed: ${response.status} ${error}`);
  }
}

/**
 * Get LINE user profile
 * @param userId - LINE user ID
 */
export async function getUserProfile(
  userId: string
): Promise<LineUserProfile> {
  const token = getChannelAccessToken();

  const response = await fetch(`${LINE_API_BASE}/profile/${userId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get LINE profile: ${response.status}`);
  }

  return response.json();
}

/**
 * Create a text message object
 */
export function textMessage(text: string): LineTextMessage {
  // LINE has a 5000 character limit per text message
  // If text is longer, truncate with a note
  if (text.length > 4900) {
    text = text.substring(0, 4900) + '\n\n（メッセージが長すぎるため省略されました）';
  }
  return { type: 'text', text };
}

// ----- Types -----

export interface LineTextMessage {
  type: 'text';
  text: string;
}

export type LineMessage = LineTextMessage;
// Add more message types (image, template, flex, etc.) as needed

export interface LineUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
}

export interface LineWebhookEvent {
  type: string;
  message?: {
    type: string;
    id: string;
    text?: string;
  };
  replyToken: string;
  source: {
    type: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  timestamp: number;
  mode: string;
}

export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}
