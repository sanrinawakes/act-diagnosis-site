import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

let GET: typeof import('../src/app/api/internal/support-report/route').GET;

beforeAll(async () => {
  vi.stubEnv('SUPPORT_REPORT_READ_SECRET', 'r'.repeat(64));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
  ({ GET } = await import('../src/app/api/internal/support-report/route'));
});

it('keeps legacy open tickets in the legacy count after a recent manual reply', async () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const supportTickets = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      subject: 'Old issue',
      status: 'in_progress',
      category: 'bug',
      created_at: '2026-04-15T04:50:36.151Z',
      updated_at: recent,
      message: 'Manual reply saved',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      subject: '返金を希望します',
      status: 'open',
      category: 'billing',
      created_at: '2026-08-15T04:50:36.151Z',
      updated_at: recent,
      message: 'New question',
    },
  ];

  mocks.createClient.mockReturnValue({
    from(table: string) {
      const rows = table === 'support_tickets' ? supportTickets : [];
      return {
        select(_columns: string, options?: { head?: boolean }) {
          let filtered = [...rows];
          const query = {
            order() { return query; },
            range(start: number, end: number) {
              filtered = filtered.slice(start, end + 1);
              return query;
            },
            in(column: string, values: string[]) {
              filtered = filtered.filter((row) => values.includes(String(row[column as keyof typeof row])));
              return query;
            },
            not(column: string) {
              filtered = filtered.filter((row) => !['resolved', 'closed'].includes(String(row[column as keyof typeof row])));
              return query;
            },
            gte(column: string, value: string) {
              filtered = filtered.filter((row) => String(row[column as keyof typeof row]) >= value);
              return query;
            },
            lt(column: string, value: string) {
              filtered = filtered.filter((row) => String(row[column as keyof typeof row]) < value);
              return query;
            },
            then(resolve: (result: { data: typeof filtered; count: number; error: null }) => void) {
              resolve({ data: options?.head ? [] : filtered, count: filtered.length, error: null });
            },
          };
          return query;
        },
      };
    },
  });

  const response = await GET(new NextRequest('https://example.com/api/internal/support-report', {
    headers: { Authorization: `Bearer ${'r'.repeat(64)}` },
  }));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.openTickets.map((ticket: { id: string }) => ticket.id)).toEqual([
    supportTickets[1].id,
  ]);
  expect(body.openTickets[0].ownerActionRequired).toBe(true);
  expect(body.openTickets[0].ownerDecisionReasons).toContain('refund');
  expect(body.legacyOpenCount).toBe(1);
});
