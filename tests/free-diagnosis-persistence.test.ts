import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('../src/lib/supabase-server', () => ({ createServerClient: mocks.createServerClient }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

import { POST } from '../src/app/api/free/diagnosis/route';

type Row = Record<string, unknown> & { id: string; email: string };
type DatabaseError = { code: string; message: string };

function database() {
  const rows = new Map<string, Row>();
  const insertedIds: string[] = [];
  const updates: { filters: Record<string, unknown>; values: Record<string, unknown> }[] = [];
  let synchronizeFirstReads = false;
  let initialReads = 0;
  let releaseReads: () => void = () => {};
  const readsReady = new Promise<void>((resolve) => { releaseReads = resolve; });
  const errors = {
    insert: null as DatabaseError | null,
    select: null as DatabaseError | null,
    retrySelect: null as DatabaseError | null,
    update: null as DatabaseError | null,
  };
  const controls = { beforeUpdate: null as (() => void) | null };

  return {
    rows,
    insertedIds,
    updates,
    errors,
    controls,
    synchronizeFirstReads: () => { synchronizeFirstReads = true; },
    from: (table: string) => {
      if (table !== 'free_users') throw new Error(`Unexpected table: ${table}`);
      const filters: Record<string, unknown> = {};
      let values: Record<string, unknown> | null = null;
      const execute = async () => {
        if (values) controls.beforeUpdate?.();
        const matches = [...rows.values()]
          .filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value))
          .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
        if (values) {
          updates.push({ filters: { ...filters }, values: { ...values } });
          if (errors.update) return { data: null, error: errors.update };
          for (const row of matches) Object.assign(row, values);
          return { data: matches[0] ? { ...matches[0] } : null, error: null };
        }
        const error = 'id' in filters ? errors.retrySelect : errors.select;
        const snapshot = matches[0] ? { ...matches[0] } : null;
        if (synchronizeFirstReads && !('id' in filters) && ++initialReads <= 2) {
          if (initialReads === 2) releaseReads();
          await readsReady;
        }
        return { data: snapshot, error };
      };
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters[key] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: execute,
        update: (updateValues: Record<string, unknown>) => { values = updateValues; return query; },
        insert: async (insertValues: Record<string, unknown>) => {
          const id = typeof insertValues.id === 'string' ? insertValues.id : randomUUID();
          insertedIds.push(id);
          if (errors.insert) return { error: errors.insert };
          if (rows.has(id)) return { error: { code: '23505', message: 'duplicate primary key' } };
          rows.set(id, { ...insertValues, id } as Row);
          return { error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject),
      };
      return query;
    },
  };
}

function request(body: Record<string, unknown> = {}, origin = 'https://acti.example.test') {
  return new NextRequest('https://acti.example.test/api/free/diagnosis', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      email: 'member@example.test',
      answers: Array(15).fill(0),
      level: 2,
      typeCode: 'MMM',
      ...body,
    }),
  });
}

describe('free diagnosis persistence and retries', () => {
  let db: ReturnType<typeof database>;
  const user = { id: 'b6656429-a4fd-4be9-baf2-0edc6db4afda', email: 'member@example.test' };

  beforeEach(() => {
    vi.clearAllMocks();
    db = database();
    mocks.createClient.mockReturnValue(db);
    mocks.createServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { ...user } }, error: null }) },
    });
  });

  it('saves one row when a retry overlaps the first save after both requests read an empty account', async () => {
    db.synchronizeFirstReads();
    const responses = await Promise.all([POST(request()), POST(request())]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(db.rows.size).toBe(1);
    expect(db.insertedIds).toHaveLength(2);
    expect(new Set(db.insertedIds).size).toBe(1);
    expect(db.insertedIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...db.rows.values()][0]).toMatchObject({
      email: user.email,
      diagnosis_completed: true,
      diagnosis_level: 2,
      diagnosis_type_code: 'MMM',
    });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].filters).toEqual({ id: db.insertedIds[0], email: user.email });
  });

  it('updates the oldest legacy email row and preserves its quota and creation time', async () => {
    db.rows.set('legacy-oldest', { id: 'legacy-oldest', email: user.email, created_at: '2026-01-01', chat_count_today: 3 });
    db.rows.set('legacy-newer', { id: 'legacy-newer', email: user.email, created_at: '2026-02-01', diagnosis_level: 1 });

    expect((await POST(request())).status).toBe(200);
    expect(db.insertedIds).toHaveLength(0);
    expect(db.rows.get('legacy-oldest')).toMatchObject({ diagnosis_level: 2, chat_count_today: 3, created_at: '2026-01-01' });
    expect(db.rows.get('legacy-newer')).toMatchObject({ diagnosis_level: 1 });
  });

  it('reuses the saved row after a response is lost without resetting its quota', async () => {
    await POST(request()); // The server saved successfully, but its response was lost.
    const row = [...db.rows.values()][0];
    const originalId = row.id;
    const createdAt = row.created_at;
    row.chat_count_today = 3;

    expect((await POST(request({ level: 1 }))).status).toBe(200);
    expect(db.rows.size).toBe(1);
    expect(db.insertedIds).toEqual([originalId]);
    expect(db.rows.get(originalId)).toMatchObject({ diagnosis_level: 1, chat_count_today: 3, created_at: createdAt });
  });

  it('binds a new row ID to the authenticated owner as well as the email', async () => {
    expect((await POST(request())).status).toBe(200);
    const originalId = [...db.rows.keys()][0];
    db.rows.clear();
    mocks.createServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { ...user, id: 'd4f88070-cb21-41b2-b471-eb989d9683c1' } }, error: null }) },
    });

    expect((await POST(request())).status).toBe(200);
    expect([...db.rows.keys()][0]).not.toBe(originalId);
  });

  it('does not report a successful save if the selected row disappears before update', async () => {
    db.rows.set('legacy', { id: 'legacy', email: user.email });
    db.controls.beforeUpdate = () => db.rows.delete('legacy');

    expect((await POST(request())).status).toBe(500);
    expect(db.rows.size).toBe(0);
  });

  it('uses a different stable row after the authenticated email changes and reuses it on retry', async () => {
    expect((await POST(request())).status).toBe(200);
    const originalId = [...db.rows.keys()][0];
    mocks.createServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { ...user, email: 'new@example.test' } }, error: null }) },
    });
    expect((await POST(request({ email: ' NEW@example.test ' }))).status).toBe(200);
    expect((await POST(request({ email: 'new@example.test', level: 1 }))).status).toBe(200);

    expect(db.rows.size).toBe(2);
    expect(db.rows.get(originalId)?.email).toBe(user.email);
    expect([...db.rows.values()].find((row) => row.email === 'new@example.test')).toMatchObject({ diagnosis_level: 1 });
    expect(new Set(db.insertedIds).size).toBe(2);
  });

  it('does not overwrite a conflicting deterministic ID belonging to another email', async () => {
    expect((await POST(request())).status).toBe(200);
    const row = [...db.rows.values()][0];
    row.email = 'other@example.test';
    row.diagnosis_level = 1;
    const snapshot = { ...row };
    db.updates.length = 0;

    expect((await POST(request())).status).toBe(403);
    expect(db.rows.size).toBe(1);
    expect(db.rows.get(row.id)).toEqual(snapshot);
    expect(db.updates).toHaveLength(0);
  });

  it.each(['select', 'insert', 'update', 'retrySelect'] as const)('returns500 when the %s operation fails', async (operation) => {
    if (operation === 'update') {
      db.rows.set('legacy', { id: 'legacy', email: user.email });
    } else if (operation === 'retrySelect') {
      expect((await POST(request())).status).toBe(200);
      [...db.rows.values()][0].email = 'other@example.test';
    }
    db.errors[operation] = { code: 'XX000', message: 'database unavailable' };

    expect((await POST(request())).status).toBe(500);
  });

  it('does not accept an unrelated unique conflict as a successful save', async () => {
    db.errors.insert = { code: '23505', message: 'unrelated unique conflict' };
    expect((await POST(request())).status).toBe(403);
    expect(db.rows.size).toBe(0);
    expect(db.updates).toHaveLength(0);
  });

  it('rejects an unauthenticated request before creating the database client', async () => {
    mocks.createServerClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) } });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('rejects another email and a foreign origin before any database write', async () => {
    expect((await POST(request({ email: 'other@example.test' }))).status).toBe(403);
    expect((await POST(request({}, 'https://other.example.test'))).status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each([
    { answers: Array(14).fill(0) },
    { answers: [...Array(14).fill(0), 3] },
    { answers: [...Array(14).fill(0), 0.5] },
    { level: 3 },
    { typeCode: 'invalid' },
  ])('preserves request validation for %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
