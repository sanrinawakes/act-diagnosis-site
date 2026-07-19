import { createClient } from '@supabase/supabase-js';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  })
);

const baseUrl = args.get('base') || 'https://act-diagnosis-site.vercel.app';
const mode = args.get('mode') || 'all';
const maxTotalMs = Number(args.get('max-ms') || 15000);
const maxFirstChunkMs = Number(args.get('max-first-chunk-ms') || 10000);
const vercelProtectionHeaders = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? {
      'x-vercel-protection-bypass':
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    }
  : {};

const supabase =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } }
      )
    : null;

const shouldRunNormal = mode === 'all' || mode === 'normal';
const shouldRunLongHistory = mode === 'all' || mode === 'long';
const shouldRunConcurrency = mode === 'all' || mode === 'concurrent';
const createdEmails = [];

try {
  const results = [];

  if (shouldRunNormal) {
    results.push(...(await runNormalConversation()));
  }

  if (shouldRunLongHistory) {
    results.push(await runLongHistoryConversation());
  }

  if (shouldRunConcurrency) {
    results.push(...(await runConcurrentConversations()));
  }

  assertResults(results);
  console.log(JSON.stringify({ ok: true, baseUrl, results }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function runNormalConversation() {
  const email = uniqueEmail('normal');
  createdEmails.push(email);
  const messages = [];
  const userInputs = [
    '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
    '上司に否定されたように感じて、次の一言が怖いです。',
    'では、明日まず何をすればいいか一つだけ教えてください。',
  ];
  const results = [];

  for (let index = 0; index < userInputs.length; index += 1) {
    messages.push({ role: 'user', content: userInputs[index] });
    const result = await sendStreamRequest({
      email,
      diagnosisCode: 'PMA-2',
      messages,
      label: `normal-${index + 1}`,
    });
    messages.push({ role: 'assistant', content: result.message });
    results.push(result);
  }

  return results;
}

async function runLongHistoryConversation() {
  const email = uniqueEmail('long-history');
  createdEmails.push(email);
  const messages = [];

  for (let index = 0; index < 218; index += 1) {
    messages.push({ role: 'user', content: buildFiller(index) });
    messages.push({
      role: 'assistant',
      content: `受け止めました。${buildFiller(index)}`,
    });
  }

  messages.push({
    role: 'user',
    content: '明日まず何をすればいいか、一つだけ短く教えてください。',
  });

  return sendStreamRequest({
    email,
    diagnosisCode: 'SMM-1',
    messages,
    label: 'long-history-437',
  });
}

async function runConcurrentConversations() {
  return Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const email = uniqueEmail(`concurrent-${index + 1}`);
      createdEmails.push(email);
      return sendStreamRequest({
        email,
        diagnosisCode: 'MME-3',
        messages: [
          {
            role: 'user',
            content: `同時接続テスト${index + 1}です。今日は少し疲れました。短く返してください。`,
          },
        ],
        label: `concurrent-${index + 1}`,
      });
    })
  );
}

async function sendStreamRequest({ email, diagnosisCode, messages, label }) {
  const body = { email, diagnosisCode, messages, stream: true };
  const payloadBytes = Buffer.byteLength(JSON.stringify(body));
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/free/chat`, {
    method: 'POST',
    headers: {
      ...vercelProtectionHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error(`${label} did not return a stream body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let message = '';
  let firstChunkMs = null;
  let doneMs = null;
  let donePayload = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const event = parseEventLine(line);
      if (!event) continue;

      if (event.type === 'chunk' && event.text) {
        firstChunkMs ??= Date.now() - startedAt;
        message += event.text;
      }

      if (event.type === 'done') {
        doneMs = Date.now() - startedAt;
        donePayload = event;
        if (event.message && event.message !== message) {
          message = event.message;
        }
      }

      if (event.type === 'error') {
        throw new Error(`${label} stream error: ${event.error || 'unknown'}`);
      }
    }
  }

  const trailingEvent = parseEventLine(buffer);
  if (trailingEvent?.type === 'done') {
    doneMs = Date.now() - startedAt;
    donePayload = trailingEvent;
    if (trailingEvent.message && trailingEvent.message !== message) {
      message = trailingEvent.message;
    }
  }

  return {
    label,
    lastUserText: messages.at(-1)?.content || '',
    status: response.status,
    inputMessages: messages.length,
    payloadBytes,
    firstChunkMs,
    doneMs,
    totalMs: Date.now() - startedAt,
    hasDone: Boolean(donePayload),
    completionStatus: donePayload?.completionStatus ?? null,
    outputChars: message.length,
    remaining: donePayload?.remaining ?? null,
    userGrounding: {
      expectation: messages.some(
        (message) => message.role === 'user' && /期待|応え/.test(message.content)
      ),
      intimidation: messages.some(
        (message) => message.role === 'user' && /萎縮/.test(message.content)
      ),
      emotionSwitching: messages.some(
        (message) => message.role === 'user' && /切り替え/.test(message.content)
      ),
      emphaticCause: messages.some(
        (message) =>
          message.role === 'user' && /(?:だからこそ|からこそ)/.test(message.content)
      ),
    },
    message,
  };
}

function assertResults(results) {
  for (const result of results) {
    if (!result.hasDone) {
      throw new Error(`${result.label} did not receive done event`);
    }
    if (result.completionStatus !== 'complete') {
      throw new Error(
        `${result.label} did not complete generation: ${result.completionStatus || 'missing status'}`
      );
    }
    if (result.firstChunkMs === null || result.firstChunkMs > maxFirstChunkMs) {
      throw new Error(
        `${result.label} first chunk too slow: ${result.firstChunkMs}ms`
      );
    }
    if (result.totalMs > maxTotalMs) {
      throw new Error(`${result.label} total too slow: ${result.totalMs}ms`);
    }
    if (/応答に時間がかかりすぎ|応答に失敗|中断しました/.test(result.message)) {
      throw new Error(`${result.label} returned fallback text`);
    }
    if (
      ['normal-3', 'long-history-437'].includes(result.label) &&
      /今できる最小の行動を一つだけ決めて/.test(result.message)
    ) {
      throw new Error(
        `${result.label} lost the conversation context: ${result.message}`
      );
    }
    if (
      requestsSingleAnswerInSmoke(result.lastUserText) &&
      !requestsExplicitClosingQuestionInSmoke(result.lastUserText) &&
      result.message.split(/\n{2,}/).filter(Boolean).length !== 1
    ) {
      throw new Error(
        `${result.label} returned multiple answer blocks: ${result.message}`
      );
    }
    if (
      /お察し(?:いた)?します|承知(?:いた)?しました|いらっしゃる|差し支えなければ|よろしければ|(?:お聞かせ|聞かせて|教えて|お話し|話して)いただけますか|お聞かせいただけますでしょうか|させていただけますでしょうか|となっております|お伺いいたします|お気軽に(?:ご質問|お尋ね|ご相談)|頑張られ|素晴らしい一歩|サポートさせていただきます|ご無理なさらず|ご安心ください|お過ごしください|(?:教えて|お話しして|話して)くださ(?:り|って)ありがとうございます|(?:お気持ち|気持ち).{0,8}よく(?:分|わ)かります|何か(?:具体的に|続けて)?(?:お話し|話して)(?:みたい|したい)?ことはありますか|何か[、,]?(?:今)?(?:感じていることや[、,]?)?(?:話したい|話してみたい)ことはありますか|今[、,]?(?:この瞬間に)?(?:最も|一番)?(?:話したい|話してみたい)ことは何ですか|あなたの言葉一つ一つを大切に受け止めています|見捨てられ|承認欲求|トラウマ|幼少期|愛着障害|共依存|我慢.{0,12}証拠|という喧嘩|タタスク|タースク|タムスケジュール/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} returned overly formal coaching text: ${result.message}`
      );
    }
    if (
      /否定.{0,6}(?:ではなく|でなく).{0,8}意見|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,16}(?:横|脇)[にへ]置|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,12}切り離|客観的に見つめ直/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} invalidated the user's stated feeling: ${result.message}`
      );
    }
    if (
      (/期待に応え/.test(result.message) &&
        !result.userGrounding.expectation) ||
      (/萎縮/.test(result.message) && !result.userGrounding.intimidation)
      || (/気持ちの切り替え/.test(result.message) &&
        !result.userGrounding.emotionSwitching)
      || (/(?:だからこそ|からこそ)/.test(result.message) &&
        !result.userGrounding.emphaticCause)
    ) {
      throw new Error(
        `${result.label} invented an unsupported psychological inference: ${result.message}`
      );
    }
  }
}

function requestsSingleAnswerInSmoke(text) {
  return /(?:(?:一つ|ひとつ|1つ)(?:だけ)?.{0,24}(?:教|提案|答|挙|示|伝|お願)|(?:教|提案|答|挙|示|伝|お願).{0,24}(?:一つ|ひとつ|1つ)(?:だけ)?|一言(?:だけ|で)|最初の一言|質問(?:は|を)?(?:なし|不要|しない)|短く(?:答|教|返))/.test(
    text
  );
}

function requestsExplicitClosingQuestionInSmoke(text) {
  if (
    /質問(?:は|を)?(?:なし|不要|しない|せず)|質問を付けない|質問で終わらない/.test(
      text
    )
  ) {
    return false;
  }

  return /(?:最後|末尾|終わり|締め).{0,40}質問|質問(?:を|は)?[^。！？?\n]{0,20}(?:一つ|ひとつ|1つ)(?:だけ)?[^。！？?\n]{0,12}(?:して|付け|添え|ください|お願い)/.test(
    text
  );
}

async function cleanup() {
  if (!supabase || createdEmails.length === 0) return;

  const { error } = await supabase
    .from('free_users')
    .delete()
    .in('email', createdEmails);

  if (error) {
    console.error(`Failed to delete smoke test users: ${error.message}`);
  }
}

function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function uniqueEmail(prefix) {
  return `codex-smoke-${prefix}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}@example.com`;
}

function buildFiller(index) {
  return `これは長い履歴テスト用のダミー文です ${index}。仕事の悩み、人間関係、SNSへの抵抗感、明日の一歩について相談しています。`.repeat(
    10
  );
}
