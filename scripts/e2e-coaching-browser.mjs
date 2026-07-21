import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  })
);
const baseUrl = args.get('base') || 'https://act-diagnosis-site.vercel.app';
const vercelProtectionHeaders = {
  ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? {
        'x-vercel-protection-bypass':
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }
    : {}),
  ...(process.env.VERCEL_OIDC_TOKEN
    ? {
        'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN,
      }
    : {}),
};
const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const attachmentBucket = 'acti-attachments';
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const email = `codex-browser-${runId}@example.com`;
const password = `Browser-${randomUUID()}-9a!`;
const checks = [];
const timings = [];
const browserErrors = [];
const generatedCoachingOutputs = [];
let userId = null;
let sessionId = null;
let longHistorySessionId = null;
let browser = null;

try {
  await createTestMember();
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  await configureVercelProtectionBypass(desktop);
  const desktopPage = await desktop.newPage();
  collectBrowserErrors(desktopPage, 'desktop');
  await loginAndOpenNewChat(desktopPage);
  sessionId = readSessionId(desktopPage.url());
  addCheck('PC: 有料会員でセッションを作成', Boolean(sessionId), sessionId || 'none');

  await testJapaneseCompositionEnter(desktopPage);
  await testShiftEnter(desktopPage);
  await testDesktopEnterSend(desktopPage);
  await testSynchronousDoubleSendGuard(desktopPage);
  await testRepeatedConversation(desktopPage);
  await testReloadPersistence(desktopPage);
  await testIncompleteStreamRecovery(desktopPage);
  await testImageAttachment(desktopPage);
  await testDesktopLayout(desktopPage);
  await testSidebarHistory(desktopPage);
  await testLongHistoryPaging(desktopPage);

  const desktopScreenshot = join(tmpdir(), `acti-coaching-desktop-${runId}.png`);
  await desktopPage.screenshot({ path: desktopScreenshot, fullPage: false });
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  await configureVercelProtectionBypass(mobile);
  const mobilePage = await mobile.newPage();
  collectBrowserErrors(mobilePage, 'mobile');
  await loginToExistingChat(mobilePage, sessionId);
  await testMobileEnterAndButton(mobilePage);
  await testMobileLayout(mobilePage);

  const mobileScreenshot = join(tmpdir(), `acti-coaching-mobile-${runId}.png`);
  await mobilePage.screenshot({ path: mobileScreenshot, fullPage: false });
  await mobile.close();

  addCheck(
    'ブラウザ: JavaScript例外なし',
    browserErrors.length === 0,
    browserErrors.join(' | ')
  );
  const invalidOutputs = generatedCoachingOutputs.filter(({ content }) =>
    /お察し(?:いた)?します|承知(?:いた)?しました|ご安心ください|頑張られ|素晴らしい一歩|させていただけますでしょうか|(?:教えて|お話しして|話して)くださ(?:り|って)ありがとうございます|(?:お気持ち|気持ち).{0,8}よく(?:分|わ)かります|何か(?:具体的に|続けて)?(?:お話し|話して)(?:みたい|したい)?ことはありますか|何か[、,]?(?:今)?(?:感じていることや[、,]?)?(?:話したい|話してみたい)ことはありますか|今[、,]?(?:この瞬間に)?(?:最も|一番)?(?:話したい|話してみたい)ことは何ですか|あなたの言葉一つ一つを大切に受け止めています|見捨てられ|承認欲求|トラウマ|幼少期|愛着障害|共依存|我慢.{0,12}証拠|という喧嘩|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,16}(?:横|脇)[にへ]置|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,12}切り離|(?:て|で)から[^。\n]{0,60}(?:て|で)から|タタスク|タースク|タムスケジュール|(?:です|ます)[。．]\s*か[？?]|途中で止まることはありません|必ず(?:回答|返答)します/.test(
      content
    )
  );
  addCheck(
    'AI回答: 既知の日本語崩れ・事実でない稼働保証なし',
    invalidOutputs.length === 0,
    JSON.stringify(invalidOutputs)
  );

  const failed = checks.filter((check) => !check.passed);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        baseUrl,
        runId,
        summary: {
          checks: checks.length,
          passed: checks.length - failed.length,
          failed: failed.length,
        },
        checks,
        timings,
        screenshots: {
          desktop: desktopScreenshot,
          mobile: mobileScreenshot,
        },
        browserErrors,
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
  if (browser) await browser.close().catch(() => {});
  await cleanup();
}

async function createTestMember() {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'CodexブラウザE2E' },
  });
  if (error || !data.user) {
    throw new Error(`Failed to create browser test user: ${error?.message}`);
  }
  userId = data.user.id;

  const { error: profileError } = await admin.from('profiles').upsert({
    id: userId,
    email,
    display_name: 'CodexブラウザE2E',
    role: 'member',
    is_active: true,
    subscription_status: 'active',
    subscribed_at: new Date().toISOString(),
    chat_count_today: 0,
  });
  if (profileError) throw profileError;
}

async function configureVercelProtectionBypass(context) {
  if (Object.keys(vercelProtectionHeaders).length === 0) return;

  const appOrigin = new URL(baseUrl).origin;
  await context.route(`${appOrigin}/**`, async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        ...vercelProtectionHeaders,
      },
    });
  });
}

async function loginAndOpenNewChat(page) {
  const redirect = '/coaching?new=1&code=PMA-2';
  await login(page, redirect);
  await waitForChatReady(page);
}

async function loginToExistingChat(page, sid) {
  await login(page, `/coaching?session=${sid}`);
  await waitForChatReady(page);
}

async function login(page, redirect) {
  await page.goto(
    `${baseUrl}/login?redirect=${encodeURIComponent(redirect)}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await Promise.all([
    page.waitForURL(/\/coaching(?:\?|$)/, { timeout: 30000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function waitForChatReady(page) {
  await page.locator('textarea').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => {
    const textarea = document.querySelector('textarea');
    return textarea && !textarea.disabled;
  }, null, { timeout: 30000 });
  await page.waitForURL(/session=[0-9a-f-]{36}/i, { timeout: 30000 });
}

async function testJapaneseCompositionEnter(page) {
  const textarea = page.locator('textarea');
  const before = await countMessages(sessionId);
  await textarea.fill('日本語の変換確定テスト');
  await textarea.evaluate((element) => {
    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true, data: '日本語' })
    );
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
    );
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '日本語' })
    );
  });
  await page.waitForTimeout(600);
  const after = await countMessages(sessionId);
  addCheck(
    'PC: 日本語変換確定Enterで送信しない',
    before === after && (await textarea.inputValue()).includes('変換確定テスト'),
    `before=${before}, after=${after}`
  );
}

async function testShiftEnter(page) {
  const textarea = page.locator('textarea');
  const before = await countMessages(sessionId);
  await textarea.fill('一行目');
  await textarea.press('Shift+Enter');
  await textarea.type('二行目');
  await page.waitForTimeout(400);
  const after = await countMessages(sessionId);
  addCheck(
    'PC: Shift+Enterは改行して送信しない',
    before === after && (await textarea.inputValue()) === '一行目\n二行目',
    JSON.stringify(await textarea.inputValue())
  );
}

async function testDesktopEnterSend(page) {
  const marker = `PC-Enter送信-${runId}`;
  const startedAt = Date.now();
  await page.locator('textarea').fill(`${marker}。明日の一歩を一つ教えてください。`);
  await page.locator('textarea').press('Enter');
  const result = await waitForCompletedTurn(marker);
  recordGeneratedOutput('desktop-enter', result.assistantContent);
  timings.push({ name: 'desktop-enter', elapsedMs: Date.now() - startedAt });
  addCheck(
    'PC: Enterで一度だけ送信して回答を保存',
    result.userRows === 1 && result.assistantContent.length >= 8,
    JSON.stringify(result)
  );
}

async function testSynchronousDoubleSendGuard(page) {
  const marker = `二重送信防止-${runId}`;
  await page.locator('textarea').fill(`${marker}。短く答えてください。`);
  await page.locator('button', { hasText: /^送信$/ }).evaluate((button) => {
    button.click();
    button.click();
  });
  const result = await waitForCompletedTurn(marker);
  recordGeneratedOutput('double-send', result.assistantContent);
  addCheck(
    'PC: 同期的な二重クリックでもユーザー行は1件',
    result.userRows === 1,
    JSON.stringify(result)
  );
}

async function testRepeatedConversation(page) {
  const prompts = [
    '仕事を完璧にしようとして着手できません。',
    '失敗より、能力がないと思われるのが怖いです。',
    '三回目の送信です。今も前の話を踏まえられていますか？',
    `${'長い相談でも止まらないことを確認します。'.repeat(35)}最後に、明日の行動を一つだけ教えてください。`,
  ];

  for (let index = 0; index < prompts.length; index += 1) {
    const marker = `連続送信${index + 1}-${runId}`;
    const startedAt = Date.now();
    await page.locator('textarea').fill(`${marker} ${prompts[index]}`);
    await page.locator('button', { hasText: /^送信$/ }).click();
    const result = await waitForCompletedTurn(marker, 70000);
    recordGeneratedOutput(`repeated-${index + 1}`, result.assistantContent);
    timings.push({
      name: `repeated-${index + 1}`,
      elapsedMs: Date.now() - startedAt,
    });
    addCheck(
      `PC: 連続${index + 1}回目が完了`,
      result.userRows === 1 && result.assistantContent.length >= 8,
      JSON.stringify(result)
    );
  }
}

async function testReloadPersistence(page) {
  const before = await latestConversationRows(sessionId, 2);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForChatReady(page);
  const assistantText = String(before[0]?.content || '');
  const userText = String(before[1]?.content || '');
  const pageText = await page.locator('body').innerText();
  addCheck(
    'PC: 再読み込み後も最後の質問と回答を表示',
    Boolean(assistantText) &&
      Boolean(userText) &&
      pageText.includes(assistantText.slice(0, 20)) &&
      pageText.includes(userText.slice(0, 20)),
    `user=${userText.slice(0, 40)}, assistant=${assistantText.slice(0, 40)}`
  );
}

async function testIncompleteStreamRecovery(page) {
  const marker = `途中切断復旧-${runId}`;
  await page.route(
    '**/api/monitor/coaching/client-error',
    (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true, testIntercepted: true }),
      }),
    { times: 1 }
  );
  await page.route(
    '**/api/chat',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: `${JSON.stringify({ type: 'chunk', text: '途中までの回答です。' })}\n`,
      }),
    { times: 1 }
  );

  await page
    .locator('textarea')
    .fill(`${marker}。接続が切れても相談文を残してください。`);
  await page.locator('button', { hasText: /^送信$/ }).click();
  const result = await waitForCompletedTurn(marker, 30000);
  addCheck(
    '途中切断: 相談文と再試行案内を履歴へ保存',
    result.userRows === 1 &&
      result.assistantContent.includes('AIの応答が途中で切れました。') &&
      result.assistantContent.includes('入力内容は保存されています。') &&
      !result.assistantContent.includes('途中までの回答です。'),
    JSON.stringify(result)
  );

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForChatReady(page);
  const pageText = await page.locator('body').innerText();
  addCheck(
    '途中切断: 再読み込み後も相談文と案内を表示',
    pageText.includes(marker) &&
      pageText.includes('AIの応答が途中で切れました。') &&
      pageText.includes('入力内容は保存されています。') &&
      !pageText.includes('途中までの回答です。'),
    pageText.slice(-500)
  );
}

async function testImageAttachment(page) {
  const before = await countMessages(sessionId);
  const png = createPaddedWhitePng(4 * 1024 * 1024);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'acti-e2e-red.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await page.waitForTimeout(500);
  const afterSelect = await countMessages(sessionId);
  addCheck(
    '画像: 選択しただけでは送信しない',
    before === afterSelect,
    `before=${before}, after=${afterSelect}`
  );

  const marker = `画像添付-${runId}`;
  await page.locator('textarea').fill(`${marker}。この画像の色を一言で答えてください。`);
  await page.locator('button', { hasText: /^送信$/ }).click();
  const result = await waitForCompletedTurn(marker, 70000);
  recordGeneratedOutput('image', result.assistantContent);
  const { data: savedUserRows, error } = await admin
    .from('chat_messages')
    .select('content')
    .eq('session_id', sessionId)
    .eq('role', 'user')
    .ilike('content', `%${marker}%`);
  if (error) throw error;
  addCheck(
    '画像: アップロード・AI回答・履歴保存まで完了',
    result.userRows === 1 &&
      /白|ホワイト/.test(result.assistantContent) &&
      result.assistantContent.length <= 30 &&
      !/行動|始め|一緒に考え/.test(result.assistantContent) &&
      /\([\d.]+ (?:B|KB|MB)\)/.test(savedUserRows?.[0]?.content || '') &&
      !/\(4\.0 MB\)/.test(savedUserRows?.[0]?.content || '') &&
      /添付画像:\s*\n!\[/.test(savedUserRows?.[0]?.content || ''),
    JSON.stringify({
      ...result,
      savedUserContent: savedUserRows?.[0]?.content || '',
    })
  );
}

async function testDesktopLayout(page) {
  const textareaBox = await page.locator('textarea').boundingBox();
  const sendBox = await page.locator('button', { hasText: /^送信$/ }).boundingBox();
  addCheck(
    'PC表示: 入力欄が十分な幅で送信ボタンと重ならない',
    boxesDoNotOverlap(textareaBox, sendBox) && Boolean(textareaBox?.width >= 500),
    JSON.stringify({ textareaBox, sendBox })
  );
}

async function testSidebarHistory(page) {
  await page
    .locator('[data-testid="sidebar-loading"]')
    .waitFor({ state: 'hidden', timeout: 10000 });
  const currentSession = page.locator(`[data-session-id="${sessionId}"]`);
  await currentSession.waitFor({ state: 'visible', timeout: 10000 });
  addCheck(
    'PC履歴一覧: 読み込みが完了して現在の会話を表示',
    (await currentSession.count()) === 1,
    sessionId
  );
}

async function testLongHistoryPaging(page) {
  const originalSessionId = sessionId;
  const { data: createdSession, error: sessionError } = await admin
    .from('chat_sessions')
    .insert({
      user_id: userId,
      title: 'ACTI長履歴ページングE2E',
      message_count: 240,
      last_message_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (sessionError || !createdSession) {
    throw sessionError || new Error('Failed to create long-history session');
  }
  longHistorySessionId = createdSession.id;

  const oldestMarker = `長履歴-最古-${runId}`;
  const newestMarker = `長履歴-最新-${runId}`;
  const baseTime = Date.now() - 240 * 1000;
  const rows = Array.from({ length: 240 }, (_, index) => ({
    session_id: longHistorySessionId,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content:
      index === 0
        ? oldestMarker
        : index === 239
          ? newestMarker
          : `長履歴メッセージ${index}-${runId}`,
    created_at: new Date(baseTime + index * 1000).toISOString(),
  }));
  const { error: messagesError } = await admin.from('chat_messages').insert(rows);
  if (messagesError) throw messagesError;

  const startedAt = Date.now();
  await page.goto(`${baseUrl}/coaching?session=${longHistorySessionId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await waitForChatReady(page);
  const initialLoadMs = Date.now() - startedAt;
  const body = page.locator('body');
  addCheck(
    '長履歴: 初回は最新100件を読み込む',
    (await body.innerText()).includes(newestMarker) &&
      !(await body.innerText()).includes(oldestMarker),
    `initialLoadMs=${initialLoadMs}`
  );

  const loadOlderButton = page.locator('button', {
    hasText: '過去のメッセージを読み込む',
  });
  await loadOlderButton.click();
  await page.waitForFunction(
    () => {
      const button = Array.from(document.querySelectorAll('button')).find((item) =>
        item.textContent?.includes('過去のメッセージを読み込む')
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    null,
    { timeout: 15000 }
  );
  await loadOlderButton.click();
  await page.waitForFunction(
    (marker) => document.body.innerText.includes(marker),
    oldestMarker,
    { timeout: 15000 }
  );
  addCheck(
    '長履歴: 追加読込で最古のメッセージまで表示',
    (await body.innerText()).includes(oldestMarker) &&
      (await loadOlderButton.count()) === 0,
    `session=${longHistorySessionId}`
  );
  timings.push({ name: 'long-history-initial-load', elapsedMs: initialLoadMs });

  await page.goto(`${baseUrl}/coaching?session=${originalSessionId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await waitForChatReady(page);
}

async function testMobileEnterAndButton(page) {
  const textarea = page.locator('textarea');
  const marker = `スマホ改行-${runId}`;
  const before = await countMessages(sessionId);
  await textarea.fill(marker);
  await textarea.press('Enter');
  await textarea.type('二行目');
  await page.waitForTimeout(500);
  const afterEnter = await countMessages(sessionId);
  addCheck(
    'スマホ: Enterは改行し勝手に送信しない',
    before === afterEnter && (await textarea.inputValue()).includes('\n二行目'),
    `before=${before}, after=${afterEnter}, value=${JSON.stringify(
      await textarea.inputValue()
    )}`
  );

  await page.locator('button', { hasText: /^送信$/ }).click();
  const result = await waitForCompletedTurn(marker, 70000);
  recordGeneratedOutput('mobile', result.assistantContent);
  addCheck(
    'スマホ: 送信ボタンで回答と履歴を保存',
    result.userRows === 1 && result.assistantContent.length >= 8,
    JSON.stringify(result)
  );
}

async function testMobileLayout(page) {
  const textareaBox = await page.locator('textarea').boundingBox();
  const sendBox = await page.locator('button', { hasText: /^送信$/ }).boundingBox();
  const viewport = page.viewportSize();
  addCheck(
    'スマホ表示: 入力欄が十分な幅で送信ボタンと重ならない',
    boxesDoNotOverlap(textareaBox, sendBox) &&
      Boolean(textareaBox && viewport && textareaBox.width >= viewport.width - 40) &&
      Boolean(sendBox && viewport && sendBox.x + sendBox.width <= viewport.width + 1),
    JSON.stringify({ textareaBox, sendBox, viewport })
  );
}

async function waitForCompletedTurn(marker, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data: userRows, error: userError } = await admin
      .from('chat_messages')
      .select('id, created_at')
      .eq('session_id', sessionId)
      .eq('role', 'user')
      .ilike('content', `%${marker}%`);
    if (userError) throw userError;

    if (userRows?.length) {
      const { data: assistantRows, error: assistantError } = await admin
        .from('chat_messages')
        .select('content, created_at')
        .eq('session_id', sessionId)
        .eq('role', 'assistant')
        .gt('created_at', userRows[0].created_at)
        .order('created_at', { ascending: true })
        .limit(1);
      if (assistantError) throw assistantError;
      if (assistantRows?.[0]?.content) {
        return {
          userRows: userRows.length,
          assistantContent: assistantRows[0].content,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for completed turn: ${marker}`);
}

function recordGeneratedOutput(label, content) {
  generatedCoachingOutputs.push({ label, content });
}

async function countMessages(sid) {
  const { count, error } = await admin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sid);
  if (error) throw error;
  return count || 0;
}

async function latestConversationRows(sid, limit) {
  const { data, error } = await admin
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('session_id', sid)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

function collectBrowserErrors(page, label) {
  page.on('pageerror', (error) => {
    browserErrors.push(`${label}: pageerror: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || '';
    if (!/ERR_ABORTED/.test(failure)) {
      browserErrors.push(`${label}: requestfailed: ${request.url()} ${failure}`);
    }
  });
}

function readSessionId(url) {
  return new URL(url).searchParams.get('session');
}

function boxesDoNotOverlap(first, second) {
  if (!first || !second) return false;
  return (
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

function createPaddedWhitePng(targetBytes) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const fixedChunks = [
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ];
  const fixedSize =
    signature.length + fixedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const padding = Buffer.alloc(Math.max(1, targetBytes - fixedSize - 12));
  let state = 12345;
  for (let index = 0; index < padding.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    padding[index] = state & 0xff;
  }
  return Buffer.concat([
    signature,
    fixedChunks[0],
    pngChunk('npAD', padding),
    fixedChunks[1],
    fixedChunks[2],
  ]);
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

function addCheck(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
}

async function cleanup() {
  if (!userId) return;
  const attachmentFolder = `chat/${userId}/${new Date().toISOString().slice(0, 10)}`;
  const { data: attachmentFiles, error: attachmentListError } = await admin.storage
    .from(attachmentBucket)
    .list(attachmentFolder, { limit: 100 });
  if (attachmentListError) {
    console.error(`Failed to list browser test attachments: ${attachmentListError.message}`);
    process.exitCode = 1;
  }
  const testAttachmentPaths = (attachmentFiles || [])
    .filter((file) => file.name.includes('acti-e2e-red'))
    .map((file) => `${attachmentFolder}/${file.name}`);
  if (testAttachmentPaths.length > 0) {
    const { error: attachmentRemoveError } = await admin.storage
      .from(attachmentBucket)
      .remove(testAttachmentPaths);
    if (attachmentRemoveError) {
      console.error(
        `Failed to delete browser test attachments: ${attachmentRemoveError.message}`
      );
      process.exitCode = 1;
    }
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error(`Failed to delete browser test user: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { count: profiles, error: profileError } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('id', userId);
  const { count: sessions, error: sessionError } = await admin
    .from('chat_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  const { data: remainingAttachments, error: attachmentVerifyError } =
    await admin.storage.from(attachmentBucket).list(attachmentFolder, { limit: 100 });
  const remainingTestAttachments = (remainingAttachments || []).filter((file) =>
    file.name.includes('acti-e2e-red')
  );
  if (
    profileError ||
    sessionError ||
    attachmentVerifyError ||
    profiles !== 0 ||
    sessions !== 0 ||
    remainingTestAttachments.length !== 0
  ) {
    console.error(
      `Browser test cleanup verification failed: profiles=${profiles}, sessions=${sessions}, attachments=${remainingTestAttachments.length}`
    );
    process.exitCode = 1;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
