import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createClient } from '@supabase/supabase-js';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  })
);
const baseUrl = args.get('base') || 'https://act-diagnosis-site.vercel.app';
const attempts = Number(args.get('attempts') || 20);
const maxFirstChunkMs = Number(args.get('max-first-chunk-ms') || 10000);
const maxTotalMs = Number(args.get('max-ms') || 15000);
const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const anonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const vercelProtectionHeaders = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? {
      'x-vercel-protection-bypass':
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    }
  : {};
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const email = `codex-image-probe-${runId}@example.com`;
const password = `Image-${randomUUID()}-9a!`;
let userId = null;

try {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 40) {
    throw new Error('--attempts must be an integer between 1 and 40');
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw error || new Error('Image latency test user creation failed');
  }
  userId = data.user.id;

  const { error: profileError } = await admin.from('profiles').upsert({
    id: userId,
    email,
    display_name: 'Codex画像遅延テスト',
    role: 'member',
    is_active: true,
    subscription_status: 'active',
    subscribed_at: new Date().toISOString(),
    chat_count_today: 0,
  });
  if (profileError) throw profileError;

  const auth = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: signInError } =
    await auth.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session?.access_token) {
    throw signInError || new Error('Image latency test sign-in failed');
  }

  const attachment = {
    name: 'latency-probe.png',
    mimeType: 'image/png',
    data: createSolidPngBase64(32, 32, 255, 0, 0, 255),
  };
  const results = [];
  for (let index = 1; index <= attempts; index += 1) {
    results.push(
      await sendImage(signIn.session.access_token, attachment, index)
    );
  }

  const failed = results.filter(
    (result) =>
      !result.hasDone ||
      result.completionStatus !== 'complete' ||
      result.firstChunkMs === null ||
      result.firstChunkMs > maxFirstChunkMs ||
      result.totalMs > maxTotalMs ||
      result.outputChars < 1 ||
      result.hasFallback
  );
  const firstChunks = results
    .map((result) => result.firstChunkMs)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const summary = {
    attempts: results.length,
    failed: failed.length,
    overFirstChunkLimit: results.filter(
      (result) =>
        result.firstChunkMs === null || result.firstChunkMs > maxFirstChunkMs
    ).length,
    overTotalLimit: results.filter((result) => result.totalMs > maxTotalMs)
      .length,
    minFirstChunkMs: firstChunks.at(0) ?? null,
    medianFirstChunkMs:
      firstChunks[Math.floor(firstChunks.length / 2)] ?? null,
    p90FirstChunkMs:
      firstChunks[Math.max(0, Math.ceil(firstChunks.length * 0.9) - 1)] ??
      null,
    maxFirstChunkMs: firstChunks.at(-1) ?? null,
  };

  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        baseUrl,
        runId,
        thresholds: { maxFirstChunkMs, maxTotalMs },
        summary,
        results,
      },
      null,
      2
    )
  );
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function sendImage(accessToken, attachment, index) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      ...vercelProtectionHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      diagnosisCode: 'MGA-3',
      messages: [
        {
          role: 'user',
          content: `画像遅延テスト${index}。この画像の色を一言で答えてください。`,
        },
      ],
      attachments: [attachment],
      stream: true,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Image attempt ${index} failed: ${response.status} ${(
        await response.text()
      ).slice(0, 500)}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let message = '';
  let firstChunkMs = null;
  let donePayload = null;

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const event = parseLine(line);
      if (event?.type === 'chunk' && event.text) {
        firstChunkMs ??= Date.now() - startedAt;
        message += event.text;
      }
      if (event?.type === 'done') {
        donePayload = event;
        if (event.message) message = event.message;
      }
      if (event?.type === 'error') {
        throw new Error(event.error || `Image attempt ${index} stream error`);
      }
    }
  }

  const trailing = parseLine(buffer);
  if (trailing?.type === 'done') {
    donePayload = trailing;
    if (trailing.message) message = trailing.message;
  }

  return {
    attempt: index,
    firstChunkMs,
    totalMs: Date.now() - startedAt,
    hasDone: Boolean(donePayload),
    completionStatus: donePayload?.completionStatus || null,
    outputChars: message.length,
    hasFallback: /応答に時間がかかりすぎ|応答に失敗|中断しました/.test(
      message
    ),
  };
}

async function cleanup() {
  if (!userId) return;

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error(`Image latency cleanup failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { count, error: verifyError } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('id', userId);
  if (verifyError || count !== 0) {
    console.error(
      `Image latency cleanup verification failed: ${
        verifyError?.message || `profiles=${count}`
      }`
    );
    process.exitCode = 1;
  }
}

function createSolidPngBase64(width, height, red, green, blue, alpha) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) {
    const offset = 1 + x * 4;
    row[offset] = red;
    row[offset + 1] = green;
    row[offset + 2] = blue;
    row[offset + 3] = alpha;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseLine(line) {
  try {
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
