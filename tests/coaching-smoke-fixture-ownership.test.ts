import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as ts from 'typescript';
import { describe, it } from 'vitest';

const sourcePath = resolve(process.cwd(), 'scripts/smoke-coaching-chat.mjs');
const sourceText = readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['getOrCreateAccessToken', 'getOrCreateSessionId'];
const functions = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''));
assert.equal(functions.length, 2, 'must extract both actual smoke fixture functions');
const requiredArrays = new Set(['createdEmails', 'createdUserIds', 'createdSessionIds']);
const state = source.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node) &&
  node.declarationList.declarations.every((declaration) => ts.isIdentifier(declaration.name) &&
    (requiredArrays.has(declaration.name.text) ||
      (declaration.name.text.endsWith('ByEmail') && declaration.initializer &&
        ts.isNewExpression(declaration.initializer) && declaration.initializer.expression.getText(source) === 'Map'))));
assert.equal(state.filter((node) => node.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && requiredArrays.has(declaration.name.text))).length, 3);
const executable = [...state, ...functions].map((node) => node.getText(source)).join('\n') +
  '\n({ getOrCreateAccessToken, getOrCreateSessionId, createdEmails, createdUserIds, createdSessionIds });';

const A = 'smoke-owner-a@example.invalid';
const B = 'smoke-owner-b@example.invalid';
const ids = new Map([[A, '11111111-1111-4111-8111-111111111111'], [B, '22222222-2222-4222-8222-222222222222']]);
function deferred() { let release!: () => void; const promise = new Promise<void>((resolvePromise) => { release = resolvePromise; }); return { promise, release: () => release() }; }
function tokenFor(email: string) {
  return Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: ids.get(email), email })).toString('base64url') + '.offline-fixture-only';
}
function tokenSubject(token: string) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub; }
function harness() {
  const gates = new Map([[A, deferred()], [B, deferred()]]);
  const started: string[] = []; const completed: string[] = []; const profileRows: { id: string; email: string }[] = []; const sessionRows: { user_id: string; title: string }[] = []; const signIns: string[] = [];
  const admin = {
    auth: { admin: { createUser: async ({ email, email_confirm }: { email: string; email_confirm: boolean }) => {
      assert.equal(email_confirm, true); assert.ok(ids.has(email)); started.push(email);
      await gates.get(email)!.promise; completed.push(email);
      return { data: { user: { id: ids.get(email) } }, error: null };
    } } },
    from: (table: string) => {
      if (table === 'profiles') return { upsert: async (row: { id: string; email: string }) => {
        assert.equal(row.id, ids.get(row.email)); profileRows.push({ ...row }); return { error: null };
      } };
      assert.equal(table, 'chat_sessions', 'only the two fake fixture tables are available');
      return { insert: (row: { user_id: string; title: string }) => { sessionRows.push({ ...row }); return { select: (columns: string) => {
        assert.equal(columns, 'id'); return { single: async () => ({ data: { id: 'offline-session-' + sessionRows.length }, error: null }) };
      } }; } };
    },
  };
  const context = { admin, supabaseUrl: 'https://offline.invalid', supabaseAnonKey: 'offline-placeholder', randomUUID: () => '00000000-0000-4000-8000-000000000000',
    createClient: (url: string, key: string) => {
      assert.equal(url, 'https://offline.invalid'); assert.equal(key, 'offline-placeholder');
      return { auth: { signInWithPassword: async ({ email }: { email: string }) => { signIns.push(email); return { data: { session: { access_token: tokenFor(email) } }, error: null }; } } };
    },
  };
  // No process, fetch, real SDK, credentials or network primitive is supplied.
  const functionsAndState = vm.runInNewContext(executable, context, { timeout: 1000 }) as { getOrCreateAccessToken: (email: string) => Promise<string>; getOrCreateSessionId: (email: string) => Promise<string>; createdEmails: string[]; createdUserIds: string[]; createdSessionIds: string[] };
  return { ...functionsAndState, gates, started, completed, profileRows, sessionRows, signIns };
}
async function twoAccounts(startOrder: string[], completionOrder: string[]) {
  const h = harness(); h.createdEmails.push(...startOrder);
  const pending = new Map(startOrder.map((email) => [email, h.getOrCreateAccessToken(email)]));
  assert.deepEqual(h.started, startOrder);
  const tokens = new Map<string, string>();
  for (const email of completionOrder) { h.gates.get(email)!.release(); tokens.set(email, await pending.get(email)!); }
  assert.deepEqual(h.completed, completionOrder);
  assert.deepEqual([...h.createdEmails], startOrder, 'cleanup email tracking must retain both in start order');
  assert.deepEqual([...h.createdUserIds].sort(), [...ids.values()].sort(), 'cleanup auth tracking must retain both IDs');
  assert.equal(h.profileRows.length, 2);
  for (const email of startOrder) assert.equal(tokenSubject(tokens.get(email)!), ids.get(email));
  return { h, tokens };
}
function assertSessionOwnership(h: ReturnType<typeof harness>, email: string, token: string) {
  const row = h.sessionRows.find((candidate) => candidate.title === `Codexスモークテスト ${email}`);
  assert.ok(row, 'session insertion must exist before ownership assertion');
  assert.equal(row.user_id, tokenSubject(token), `session owner must match JWT subject for ${email}`);
}

describe('smoke fixture ownership is keyed by email rather than asynchronous array order', () => {
  it('keeps A/B ownership when auth creation completes B then A', async () => {
    const { h, tokens } = await twoAccounts([A, B], [B, A]);
    await h.getOrCreateSessionId(A); await h.getOrCreateSessionId(B);
    assert.equal(h.sessionRows.length, 2); assert.equal(h.createdSessionIds.length, 2);
    assertSessionOwnership(h, A, tokens.get(A)!); assertSessionOwnership(h, B, tokens.get(B)!);
  });
  it('keeps B/A ownership when auth creation completes A then B', async () => {
    const { h, tokens } = await twoAccounts([B, A], [A, B]);
    await h.getOrCreateSessionId(B); await h.getOrCreateSessionId(A);
    assert.equal(h.sessionRows.length, 2); assert.equal(h.createdSessionIds.length, 2);
    assertSessionOwnership(h, B, tokens.get(B)!); assertSessionOwnership(h, A, tokens.get(A)!);
  });
  it('reuses a repeated email token and session without creating another fixture', async () => {
    const { h, tokens } = await twoAccounts([A, B], [A, B]);
    const token = await h.getOrCreateAccessToken(A); assert.equal(token, tokens.get(A)!);
    const first = await h.getOrCreateSessionId(A); const second = await h.getOrCreateSessionId(A);
    assert.equal(first, second); assert.equal(h.started.length, 2); assert.equal(h.signIns.length, 2);
    assert.equal(h.sessionRows.length, 1); assert.equal(h.createdSessionIds.length, 1);
    assertSessionOwnership(h, A, token);
    assert.deepEqual([...h.createdEmails], [A, B]); assert.deepEqual([...h.createdUserIds].sort(), [...ids.values()].sort());
  });
  it('fails closed for a missing email owner even when the cleanup ID array contains another user', async () => {
    const h = harness(); h.createdEmails.push(A); h.createdUserIds.push(ids.get(B)!);
    await assert.rejects(() => h.getOrCreateSessionId(A), /session user missing|owner.*missing|user.*missing/i);
    assert.equal(h.sessionRows.length, 0); assert.equal(h.createdSessionIds.length, 0);
    assert.deepEqual([...h.createdUserIds], [ids.get(B)], 'failure must retain the tracked cleanup ID');
  });
});
