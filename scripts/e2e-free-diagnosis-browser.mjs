import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';
import { deleteTestAuthUser } from './lib/test-account-cleanup.mjs';

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args.get('base') || 'https://act-diagnosis-site.vercel.app').replace(/\/$/, '');
const runId = randomUUID();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(args.get('report') || join(tmpdir(), `acti-free-diagnosis-${runId}.json`));
const reportRelativePath = relative(repoRoot, reportPath);
assert(reportRelativePath.startsWith('..') || isAbsolute(reportRelativePath), 'Browser reports must be saved outside the repository');
const screenshotsDirectory = join(dirname(reportPath), `free-diagnosis-${runId}`);
const email = `codex-free-diagnosis-${runId}@example.com`;
const password = `Diagnosis-${randomUUID()}-9a!`;
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const admin = createClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const origin = new URL(baseUrl).origin;
const protectionHeaders = {
  ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}),
  ...(process.env.VERCEL_OIDC_TOKEN ? { 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN } : {}),
};
const checks = [];
const screenshots = {};
const requests = [];
const browserErrors = [];
const consoleErrors = [];
const cleanupCounts = {};
const startedAt = new Date().toISOString();
let browser;
let userId;
let fixtureCreationAttempted = false;
let errorMessage;
let forwardedSaves = 0;
let concurrentProbeSaves = 0;
let quotaSentinelSet = false;

// Use the actual question data while retaining compatibility with Node versions
// that cannot import TypeScript directly. This removes the type-only import.
const questionSource = await readFile(join(repoRoot, 'src/data/consciousness-questions.ts'), 'utf8');
const questionModule = ts.transpileModule(questionSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { consciousnessQuestions } = await import(`data:text/javascript;base64,${Buffer.from(questionModule).toString('base64')}`);
const questions = consciousnessQuestions.slice(0, 15);

try {
  await mkdir(screenshotsDirectory, { recursive: true });
  fixtureCreationAttempted = true;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'Codex簡易診断E2E' },
  });
  assert(!error && data.user, 'Synthetic Auth fixture creation failed');
  userId = data.user.id;
  const { error: profileError } = await admin.from('profiles').upsert({
    id: userId,
    email,
    display_name: 'Codex簡易診断E2E',
    role: 'member',
    is_active: false,
    subscription_status: 'none',
  });
  assert(!profileError, 'Synthetic free-member profile creation failed');
  check('fixture starts without a free diagnosis row', await countRows('free_users', 'email', email) === 0);
  browser = await chromium.launch({ headless: true });

  for (const [label, viewport, lowAnswers] of [
    ['desktop', { width: 1440, height: 1000 }, 2],
    ['mobile', { width: 390, height: 844 }, 3],
  ]) {
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      isMobile: label === 'mobile',
      hasTouch: label === 'mobile',
      locale: 'ja-JP',
      timezoneId: 'Asia/Seoul',
    });
    if (Object.keys(protectionHeaders).length > 0) {
      await context.route(`${origin}/**`, (route) => route.continue({ headers: { ...route.request().headers(), ...protectionHeaders } }));
    }
    const page = await context.newPage();
    page.on('pageerror', (error) => browserErrors.push({ viewport: label, message: sanitize(error.message) }));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push({ viewport: label, message: sanitize(message.text()) });
    });
    await page.goto(`${baseUrl}/login?redirect=${encodeURIComponent('/free/diagnosis')}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await Promise.all([
      page.waitForURL('**/free/diagnosis', { timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
    await questionHeading(page, 0).waitFor({ timeout: 30_000 });
    check(`${label}: first question has disabled Previous and Next`, await page.getByRole('button', { name: '戻る', exact: true }).isDisabled() && await page.getByRole('button', { name: '次へ', exact: true }).isDisabled());

    let mode = 'real';
    let failureGate = Promise.resolve();
    await page.route('**/api/free/diagnosis', async (route) => {
      const requestMode = mode;
      const currentFailureGate = failureGate;
      const payload = route.request().postDataJSON();
      const requestRecord = { viewport: label, mode: requestMode, answers: payload.answers, level: payload.level, typeCode: payload.typeCode, correctFixture: payload.email === email };
      requests.push(requestRecord);
      if (requestMode !== 'real') await currentFailureGate;
      if (typeof requestMode === 'number') {
        await route.fulfill({ status: requestMode, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic browser test rejection' }) });
      } else if (requestMode === 'network') {
        await route.abort('internetdisconnected');
      } else if (requestMode === 'timeout') {
        // The page's real 30-second AbortController must end the request. The
        // fallback bound also lets a broken client fail without hanging CI.
        let timer;
        const endedByClient = await Promise.race([
          page.waitForEvent('requestfailed', { predicate: (request) => request === route.request(), timeout: 36_000 }).then(() => true).catch(() => false),
          new Promise((resolveWait) => { timer = setTimeout(() => resolveWait(false), 35_000); }),
        ]);
        requestRecord.clientAbortedBeforeFallback = endedByClient;
        clearTimeout(timer);
        await route.abort('timedout').catch(() => {});
      } else {
        forwardedSaves++;
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
        await route.fallback();
      }
    });

    const choices = questions.map((question, index) => {
      const desired = question.choices.map((choice, choiceIndex) => ({ ...choice, choiceIndex })).filter((choice) => index < lowAnswers ? choice.score === -2 : choice.score !== -2);
      return desired.at(-1).choiceIndex;
    });
    const expectedScores = choices.map((choiceIndex, questionIndex) => questions[questionIndex].choices[choiceIndex].score);
    let inspectedOptions = 0;
    for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
      await questionHeading(page, questionIndex).waitFor();
      for (let choiceIndex = 0; choiceIndex < questions[questionIndex].choices.length; choiceIndex++) {
        await choiceButton(page, questionIndex, choiceIndex).click();
        await assertSelected(page, questionIndex, choiceIndex);
        inspectedOptions++;
      }
      await choiceButton(page, questionIndex, choices[questionIndex]).click();
      if (questionIndex === 0) {
        await assertSelected(page, questionIndex, choices[questionIndex]);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(350);
        screenshots[`${label}Question`] = join(screenshotsDirectory, `${label}-question.png`);
        await page.screenshot({ path: screenshots[`${label}Question`], fullPage: false });
        if (label === 'mobile') {
          screenshots.mobileQuestionFull = join(screenshotsDirectory, 'mobile-question-full.png');
          await page.screenshot({ path: screenshots.mobileQuestionFull, fullPage: true });
        }
      }
      if (questionIndex < questions.length - 1) await page.getByRole('button', { name: '次へ', exact: true }).click();
    }
    check(`${label}: every one of 83 choices highlights itself`, inspectedOptions === 83);
    for (let questionIndex = questions.length - 1; questionIndex >= 0; questionIndex--) {
      await assertSelected(page, questionIndex, choices[questionIndex]);
      if (questionIndex > 0) await page.getByRole('button', { name: '戻る', exact: true }).click();
    }
    for (let questionIndex = 0; questionIndex < questions.length - 1; questionIndex++) {
      await assertSelected(page, questionIndex, choices[questionIndex]);
      await page.getByRole('button', { name: '次へ', exact: true }).click();
    }
    check(`${label}: exact choices survive full next/back navigation`, true);
    check(`${label}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

    if (label === 'desktop') {
      for (const failure of [...(args.get('timeout') === 'false' ? [] : ['timeout']), 400, 401, 403, 500, 'network']) {
        mode = failure;
        let releaseFailure;
        failureGate = new Promise((resolveWait) => { releaseFailure = resolveWait; });
        const failureStartedAt = Date.now();
        await page.getByRole('button', { name: '完了', exact: true }).click();
        try {
          await page.getByText('診断を保存中...', { exact: true }).waitFor({ timeout: 10_000 });
          await saveAlert(page).waitFor({ state: 'hidden', timeout: 5_000 });
        } finally {
          releaseFailure();
        }
        await saveAlert(page).waitFor({ timeout: failure === 'timeout' ? 40_000 : 10_000 });
        const elapsedMs = Date.now() - failureStartedAt;
        if (failure === 'timeout') {
          await page.waitForTimeout(50);
          check('desktop: stalled request is aborted by the client before fallback', requests.at(-1).clientAbortedBeforeFallback === true && elapsedMs >= 29_000 && elapsedMs < 34_000, { elapsedMs });
        }
        check(`${label}: ${failure} failure keeps diagnosis visible and uncached`, new URL(page.url()).pathname === '/free/diagnosis' && await page.evaluate(() => localStorage.getItem('free_diagnosis_result') === null), { elapsedMs });
        await assertSelected(page, 14, choices[14]);
        assert.deepEqual(requests.at(-1).answers, expectedScores, 'Failure request must retain score payload');
      }
      check('intercepted failures never reach the real diagnosis API', forwardedSaves === 0 && await countRows('free_users', 'email', email) === 0);
      const probeStartedAt = Date.now();
      const concurrentResponses = await Promise.all(Array.from({ length: 2 }, () => context.request.post(`${baseUrl}/api/free/diagnosis`, {
        headers: { origin, ...protectionHeaders },
        data: { email, answers: expectedScores, level: 2, typeCode: 'MMM' },
        timeout: 20_000,
      })));
      concurrentProbeSaves = concurrentResponses.length;
      const acknowledged = await Promise.all(concurrentResponses.map(async (response) => response.status() === 200 && (await response.json()).success === true));
      check('simultaneous initial API saves both confirm success', acknowledged.every(Boolean), { elapsedMs: Date.now() - probeStartedAt, statuses: concurrentResponses.map((response) => response.status()) });
      const { data: concurrentRows, error: concurrentError } = await admin.from('free_users').select('id').eq('email', email);
      check('simultaneous initial saves create exactly one UUIDv8 result row', !concurrentError && concurrentRows.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(concurrentRows[0].id), { rowId: concurrentRows?.[0]?.id });
      const { error: sentinelError } = await admin.from('free_users').update({ chat_count_today: 2 }).eq('email', email);
      assert(!sentinelError, 'Could not set exact-fixture quota sentinel');
      quotaSentinelSet = true;
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'free_diagnosis_result') {
            Storage.prototype.setItem = original;
            throw new DOMException('Synthetic result-storage failure', 'QuotaExceededError');
          }
          return original.call(this, key, value);
        };
      });
    }

    mode = 'real';
    const beforeRequests = requests.length;
    const expectedLevel = lowAnswers >= 3 ? 1 : 2;
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/free/diagnosis' && response.request().method() === 'POST', { timeout: 20_000 });
    await page.getByRole('button', { name: '完了', exact: true }).evaluate((element) => { element.click(); element.click(); });
    const response = await responsePromise;
    assert(response.ok() && (await response.json()).success === true, 'Real API save must be confirmed');
    if (label === 'desktop') {
      await saveAlert(page).waitFor();
      check('desktop: result-storage failure stays visible after confirmed server save', new URL(page.url()).pathname === '/free/diagnosis');
      await assertDatabaseResult(expectedLevel, label);
      await page.getByRole('button', { name: '完了', exact: true }).click();
    }
    await page.waitForURL('**/free/results', { timeout: 20_000 });
    await page.getByRole('heading', { name: '診断結果', exact: true }).waitFor();
    await page.getByRole('heading', { name: new RegExp(`^レベル${expectedLevel}`) }).waitFor();
    check(`${label}: same-tick double completion and storage retry send exactly one real request`, requests.length - beforeRequests === 1);
    const savedRequest = requests.at(-1);
    assert.deepEqual(savedRequest.answers, expectedScores, 'Real save must submit scores rather than choice indexes');
    check(`${label}: score payload and low-score boundary are correct`, savedRequest.correctFixture && savedRequest.level === expectedLevel && savedRequest.typeCode === 'MMM');
    await assertDatabaseResult(expectedLevel, label);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: new RegExp(`^レベル${expectedLevel}`) }).waitFor();
    check(`${label}: reload displays the DB-confirmed level`, new URL(page.url()).pathname === '/free/results');
    screenshots[`${label}Results`] = join(screenshotsDirectory, `${label}-results.png`);
    await page.screenshot({ path: screenshots[`${label}Results`], fullPage: false });
    await context.close();
  }
  check('two viewport runs update one synthetic free-user row', forwardedSaves === 2 && await countRows('free_users', 'email', email) === 1);
  check('no uncaught JavaScript errors', browserErrors.length === 0);
} catch (error) {
  errorMessage = sanitize(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    await cleanup();
  } catch (error) {
    cleanupCounts.error = sanitize(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  const failed = checks.filter((item) => !item.passed);
  const report = {
    ok: !errorMessage && !cleanupCounts.error && failed.length === 0,
    runId,
    baseUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks,
    forwardedSaves,
    concurrentProbeSaves,
    requests,
    screenshots,
    browserErrors,
    consoleErrors,
    fixture: { email, userId: userId || null },
    cleanup: cleanupCounts,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: report.ok, report: reportPath, summary: report.summary, cleanup: cleanupCounts, ...(errorMessage ? { error: errorMessage } : {}) }));
  if (!report.ok) process.exitCode = 1;
}

function parseArgs(argumentsList) {
  const result = new Map();
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    assert(argument.startsWith('--'), 'Expected a named command argument');
    const equalIndex = argument.indexOf('=');
    if (equalIndex >= 0) result.set(argument.slice(2, equalIndex), argument.slice(equalIndex + 1));
    else if (argumentsList[index + 1] && !argumentsList[index + 1].startsWith('--')) result.set(argument.slice(2), argumentsList[++index]);
    else result.set(argument.slice(2), 'true');
  }
  return result;
}

function requireEnv(name) {
  assert(process.env[name], `${name} is required`);
  return process.env[name];
}

function sanitize(value) {
  let text = String(value);
  for (const secret of [password, serviceRoleKey, ...Object.values(protectionHeaders)]) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text.replace(/(?:access_token|refresh_token|authorization)[=:][^\s&]+/gi, '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
}

function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  assert(passed, name);
}

function questionHeading(page, index) {
  return page.getByRole('heading', { name: questions[index].text, exact: true });
}

function choiceButton(page, questionIndex, choiceIndex) {
  return page.getByRole('button', { name: questions[questionIndex].choices[choiceIndex].text, exact: true });
}

function saveAlert(page) {
  // Next.js also installs an always-present route announcer with role="alert".
  // Restrict this locator to the page's actual save-error paragraph.
  return page.locator('p[role="alert"]');
}

async function assertSelected(page, questionIndex, choiceIndex) {
  await questionHeading(page, questionIndex).waitFor();
  await page.waitForFunction(({ label }) => {
    const selected = [...document.querySelectorAll('button[aria-pressed="true"]')];
    return selected.length === 1 && selected[0].textContent.trim() === label;
  }, { label: questions[questionIndex].choices[choiceIndex].text }, { timeout: 5_000 });
}

async function countRows(table, column, value) {
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).eq(column, value);
  assert(!error, `Could not count fixture rows in ${table}`);
  return count;
}

async function assertDatabaseResult(level, label) {
  const { data, error } = await admin.from('free_users').select('id,diagnosis_completed,diagnosis_level,diagnosis_type_code,chat_count_today').eq('email', email);
  assert(!error, 'Could not read synthetic saved diagnosis');
  check(`${label}: DB has exactly one confirmed level ${level} result`, data.length === 1 && data[0].diagnosis_completed === true && data[0].diagnosis_level === level && data[0].diagnosis_type_code === 'MMM', { rowId: data[0]?.id });
  if (quotaSentinelSet) check(`${label}: repeated diagnosis saves preserve the existing daily quota`, data[0].chat_count_today === 2);
}

async function cleanup() {
  const cleanupErrors = [];
  // A lost createUser response can leave a committed fixture without returning
  // its ID. Recover only the generated email before declaring it absent.
  if (!userId && fixtureCreationAttempted) {
    try {
      userId = await recoverFixtureUserId();
    } catch (error) {
      cleanupErrors.push(sanitize(error.message));
    }
  }
  // This test only writes its own free-user row, Auth user, and profile. Never
  // delete support tickets or customer data to make cleanup verification pass.
  try {
    const { error: deleteError } = await admin.from('free_users').delete().eq('email', email);
    assert(!deleteError, 'Could not delete synthetic free-user row');
  } catch (error) {
    cleanupErrors.push(sanitize(error.message));
  }
  if (userId) {
    try {
      await deleteTestAuthUser({ admin, userId, label: 'Free diagnosis browser fixture' });
      cleanupCounts.auth = 0;
    } catch (error) {
      cleanupErrors.push(sanitize(error.message));
    }
  } else if (fixtureCreationAttempted && cleanupErrors.length === 0) cleanupCounts.auth = 0;
  const fixtureTables = [
    ['profiles', 'id', userId],
    ['chat_sessions', 'user_id', userId],
    ['diagnosis_results', 'user_id', userId],
    ['coaching_usage_events', 'user_id', userId],
    ['coaching_usage_user_stats', 'user_id', userId],
    ['coaching_monthly_usage', 'user_id', userId],
    ['free_coaching_daily_usage', 'user_id', userId],
    ['coaching_quality_incidents', 'user_id', userId],
  ];
  for (const [table, column, value] of [
    ['free_users', 'email', email],
    ['support_tickets', 'email', email],
    ...(userId ? fixtureTables : [['profiles', 'email', email]]),
  ]) {
    try {
      cleanupCounts[table] = await countRows(table, column, value);
      assert.equal(cleanupCounts[table], 0, `${table} fixture rows must be absent after cleanup`);
    } catch (error) {
      cleanupErrors.push(sanitize(error.message));
    }
  }
  if (userId) {
    try {
      const { data: files, error: storageError } = await admin.storage.from('acti-attachments').list(`chat/${userId}`, { limit: 100 });
      assert(!storageError, 'Could not verify synthetic attachment prefix');
      cleanupCounts.storage = files.length;
      assert.equal(files.length, 0, 'Synthetic attachment prefix must be empty');
    } catch (error) {
      cleanupErrors.push(sanitize(error.message));
    }
  }
  assert.equal(cleanupErrors.length, 0, cleanupErrors.join('; '));
}

async function recoverFixtureUserId() {
  const { data: profiles, error: profileError } = await admin.from('profiles').select('id').eq('email', email);
  assert(!profileError, 'Could not recover ambiguous synthetic Auth creation');
  assert(profiles.length <= 1, 'Synthetic fixture email unexpectedly matched multiple profiles');
  if (profiles.length === 1) return profiles[0].id;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    assert(!error, 'Could not verify ambiguous synthetic Auth creation');
    const fixture = data.users.find((user) => user.email === email);
    if (fixture) return fixture.id;
    if (data.users.length < 1000) return null;
  }
  throw new Error('Synthetic Auth absence could not be verified within 20 pages');
}
