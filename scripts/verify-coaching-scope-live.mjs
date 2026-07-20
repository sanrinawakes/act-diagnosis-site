import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  })
);

const baseUrl = (args.get('base') || 'https://act-diagnosis-site.vercel.app')
  .replace(/\/$/, '');
const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const scopeGuidance =
  'ACTIは、ACT診断結果を使った自己理解や、感情・行動・人間関係・仕事についての本人の相談専用です。一般的な文章添削、広告作成、翻訳、調査、プログラム作成、画像生成には対応していません。今の依頼について、あなた自身が何に悩み、どう判断し、どう行動するかを整理する相談であれば、その形でお手伝いできます。';
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const email = `codex-scope-live-${runId}@example.com`;
const password = `Scope-${randomUUID()}-9a!`;
const requestHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/x-ndjson',
  ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? {
        'x-vercel-protection-bypass':
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }
    : {}),
  ...(process.env.VERCEL_OIDC_TOKEN
    ? { 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN }
    : {}),
};

let userId = null;
let sessionId = null;
let accessToken = null;
let cleanupVerified = false;
let sessionDeleted = false;
let profileDeleted = false;
let authDeleted = false;
const checks = [];
const timings = [];

try {
  await createTestMember();
  await signInTestMember();
  await createTestSession();

  const blockedCases = [
    {
      label: 'marketing',
      expectedCategory: 'marketing_content',
      messages: [userMessage('Instagram広告の文章を3案作ってください')],
    },
    {
      label: 'marketing-followup',
      expectedCategory: 'marketing_content',
      messages: [
        userMessage('Instagram広告の文章を3案作ってください'),
        assistantMessage(scopeGuidance),
        userMessage('もっと魅力的にして'),
      ],
    },
    {
      label: 'translation',
      expectedCategory: 'translation',
      messages: [userMessage('この文章を英語に翻訳してください')],
    },
    {
      label: 'research',
      expectedCategory: 'external_research',
      messages: [userMessage('競合サービスの料金をネットで調べて比較して')],
    },
    {
      label: 'image-generation',
      expectedCategory: 'image_generation',
      messages: [userMessage('この内容に合う広告画像を生成してください')],
    },
    {
      label: 'programming',
      expectedCategory: 'programming',
      messages: [userMessage('申込フォームのJavaScriptコードを書いて')],
    },
    {
      label: 'long-paste',
      expectedCategory: 'marketing_content',
      messages: [
        userMessage(
          `販売ページを添削してください。${'これは長文貼り付けの監査試験です。'.repeat(140)}`
        ),
      ],
      expectedLong: true,
    },
  ];

  for (const testCase of blockedCases) {
    const result = await sendChat(testCase.messages);
    assertBlockedResult(testCase, result);
    timings.push({
      label: testCase.label,
      firstChunkMs: result.firstChunkMs,
      totalMs: result.totalMs,
    });
  }

  const allowedResult = await sendChat([
    userMessage(
      '夫に本音を伝えたいのですが、怒らせそうで怖いです。私がどう向き合えばよいか相談したいです。'
    ),
  ]);
  assertAllowedResult(allowedResult);
  timings.push({
    label: 'personal-coaching',
    firstChunkMs: allowedResult.firstChunkMs,
    totalMs: allowedResult.totalMs,
  });

  await verifyDatabase(blockedCases.length);
  await cleanup();
  await verifyCleanup();
  cleanupVerified = true;

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        checks,
        timings,
        cleanup: 'verified',
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl,
        checks,
        timings,
        error: sanitizeError(error),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  if (!cleanupVerified) {
    await cleanup().catch((error) => {
      console.error(`cleanup failed: ${sanitizeError(error)}`);
      process.exitCode = 1;
    });
  }
}

async function createTestMember() {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'Codex用途監査試験' },
  });
  if (error || !data.user) {
    throw new Error(`test user creation failed: ${error?.message || 'missing'}`);
  }
  userId = data.user.id;

  const { error: profileError } = await admin.from('profiles').upsert({
    id: userId,
    email,
    display_name: 'Codex用途監査試験',
    role: 'member',
    is_active: true,
    subscription_status: 'active',
    subscribed_at: new Date().toISOString(),
    chat_count_today: 0,
    last_chat_date: new Date().toISOString().slice(0, 10),
  });
  if (profileError) {
    throw new Error(`test profile creation failed: ${profileError.message}`);
  }
  addCheck('test member created');
}

async function signInTestMember() {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session?.access_token) {
    throw new Error(`test sign-in failed: ${error?.message || 'missing'}`);
  }
  accessToken = data.session.access_token;
  addCheck('test member authenticated');
}

async function createTestSession() {
  const { data, error } = await admin
    .from('chat_sessions')
    .insert({ user_id: userId, title: `Scope live ${runId}` })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`test session creation failed: ${error?.message || 'missing'}`);
  }
  sessionId = data.id;
  addCheck('test chat session created');
}

async function sendChat(messages) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      ...requestHeaders,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      sessionId,
      diagnosisCode: 'PMA-2',
      messages,
      attachments: [],
      stream: true,
    }),
    signal: AbortSignal.timeout(55000),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `chat request failed ${response.status}: ${responseText.slice(0, 300)}`
    );
  }
  if (!response.body) throw new Error('chat response body was missing');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstChunk = null;
  let done = null;
  let firstChunkMs = null;
  while (true) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const event = parseEvent(line);
      if (!event) continue;
      if (event.type === 'error') {
        throw new Error(`stream error: ${String(event.error || 'unknown')}`);
      }
      if (event.type === 'chunk' && !firstChunk) {
        firstChunk = event;
        firstChunkMs = Date.now() - startedAt;
      }
      if (event.type === 'done') done = event;
    }
  }
  if (buffer.trim()) {
    const event = parseEvent(buffer);
    if (event?.type === 'error') {
      throw new Error(`stream error: ${String(event.error || 'unknown')}`);
    }
    if (event?.type === 'chunk' && !firstChunk) {
      firstChunk = event;
      firstChunkMs = Date.now() - startedAt;
    }
    if (event?.type === 'done') done = event;
  }
  if (!firstChunk || !done) throw new Error('stream was not completed');

  return {
    firstChunkMs,
    totalMs: Date.now() - startedAt,
    message: typeof done.message === 'string' ? done.message : '',
    firstChunk,
    done,
  };
}

function assertBlockedResult(testCase, result) {
  assert(result.firstChunk.verified === true, `${testCase.label}: unverified chunk`);
  assert(result.firstChunk.text === scopeGuidance, `${testCase.label}: wrong guidance`);
  assert(result.done.message === scopeGuidance, `${testCase.label}: wrong final message`);
  assert(result.done.modelName === 'scope-guard', `${testCase.label}: provider was called`);
  assert(result.done.finishReason === 'SCOPE_BLOCKED', `${testCase.label}: wrong finish reason`);
  assert(result.done.scopeDecision === 'blocked', `${testCase.label}: not blocked`);
  assert(
    result.done.scopeCategory === testCase.expectedCategory,
    `${testCase.label}: category ${result.done.scopeCategory}`
  );
  assert(result.done.finalizationStatus === 'complete', `${testCase.label}: finalization incomplete`);
  assert(result.totalMs < 8000, `${testCase.label}: scope response too slow (${result.totalMs}ms)`);
  addCheck(`${testCase.label}: blocked before provider`);
}

function assertAllowedResult(result) {
  assert(result.done.modelName !== 'scope-guard', 'personal coaching was over-blocked');
  assert(result.done.completionStatus === 'complete', 'personal coaching did not complete');
  assert(result.done.finalizationStatus === 'complete', 'personal coaching finalization failed');
  assert(result.message.length >= 20, 'personal coaching response was too short');
  addCheck('personal consultation reached coaching provider');
}

async function verifyDatabase(blockedCount) {
  const { data: events, error: eventError } = await admin
    .from('coaching_usage_events')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (eventError || !events) {
    throw new Error(`audit event lookup failed: ${eventError?.message || 'missing'}`);
  }
  assert(events.length === blockedCount + 1, `audit event count was ${events.length}`);
  assert(
    events.filter((event) => event.decision === 'blocked').length === blockedCount,
    'blocked audit total did not match'
  );
  assert(
    events.filter((event) => event.provider_requested === false).length === blockedCount,
    'blocked request was recorded as provider requested'
  );
  assert(
    events.some((event) => event.is_long_message === true),
    'long pasted message was not recorded'
  );
  assert(
    events.every(
      (event) =>
        !Object.hasOwn(event, 'content') &&
        !Object.hasOwn(event, 'message') &&
        !Object.hasOwn(event, 'prompt')
    ),
    'private input text was present in the audit table'
  );

  const { data: stats, error: statsError } = await admin
    .from('coaching_usage_by_user')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (statsError || !stats) {
    throw new Error(`usage stats lookup failed: ${statsError?.message || 'missing'}`);
  }
  assert(Number(stats.total_requests) === blockedCount + 1, 'per-user total did not match');
  assert(Number(stats.blocked_requests) === blockedCount, 'per-user blocked total did not match');
  assert(Number(stats.allowed_requests) === 1, 'per-user allowed total did not match');
  assert(Number(stats.long_message_requests) === 1, 'per-user long total did not match');

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('chat_count_today')
    .eq('id', userId)
    .single();
  if (profileError || !profile) {
    throw new Error(`profile count lookup failed: ${profileError?.message || 'missing'}`);
  }
  assert(Number(profile.chat_count_today) === 1, 'blocked requests consumed the daily allowance');
  addCheck('audit events recorded without private message text');
  addCheck('per-user blocked, allowed, and long totals matched');
  addCheck('only the allowed consultation consumed one daily request');
}

async function cleanup() {
  if (sessionId && !sessionDeleted) {
    const { error } = await admin.from('chat_sessions').delete().eq('id', sessionId);
    if (error) throw new Error(`session cleanup failed: ${error.message}`);
    sessionDeleted = true;
  }
  if (userId) {
    const id = userId;
    if (!profileDeleted) {
      const { error: profileError } = await admin.from('profiles').delete().eq('id', id);
      if (profileError) throw new Error(`profile cleanup failed: ${profileError.message}`);
      profileDeleted = true;
    }
    if (!authDeleted) {
      const { error: authError } = await admin.auth.admin.deleteUser(id);
      if (authError) throw new Error(`auth cleanup failed: ${authError.message}`);
      authDeleted = true;
    }
  }
}

async function verifyCleanup() {
  if (!userId) throw new Error('cleanup verification is missing a user id');
  const id = userId;
  const [
    { count: eventCount, error: eventError },
    { count: statsCount, error: statsError },
    { count: profileCount, error: profileError },
    { count: sessionCount, error: sessionError },
    authLookup,
  ] =
    await Promise.all([
      admin
        .from('coaching_usage_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', id),
      admin
        .from('coaching_usage_user_stats')
        .select('user_id', { count: 'exact', head: true })
        .eq('user_id', id),
      admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('id', id),
      admin
        .from('chat_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('id', sessionId),
      admin.auth.admin.getUserById(id),
    ]);
  if (eventError || statsError || profileError || sessionError) {
    throw new Error(
      `cleanup lookup failed: ${
        eventError?.message ||
        statsError?.message ||
        profileError?.message ||
        sessionError?.message
      }`
    );
  }
  assert(eventCount === 0, `audit cleanup left ${eventCount} rows`);
  assert(statsCount === 0, `stats cleanup left ${statsCount} rows`);
  assert(profileCount === 0, `profile cleanup left ${profileCount} rows`);
  assert(sessionCount === 0, `session cleanup left ${sessionCount} rows`);
  assert(!authLookup.data.user, 'auth cleanup left the test user');
  addCheck('temporary auth, profile, session, audit, and stats data removed');
  userId = null;
  accessToken = null;
}

function userMessage(content) {
  return { role: 'user', content };
}

function assistantMessage(content) {
  return { role: 'assistant', content };
}

function parseEvent(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`malformed NDJSON event: ${line.slice(0, 120)}`);
  }
}

function addCheck(label) {
  checks.push(label);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sanitizeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 1000);
}
