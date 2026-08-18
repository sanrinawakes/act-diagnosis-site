import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) =>
  fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('Disk IO hot-path controls', () => {
  it('indexes session history, quality-audit, and stale-monitor lookups', () => {
    const migration = read(
      'supabase/migrations/032_reduce_disk_io_hot_paths.sql'
    );

    expect(migration).toContain('idx_chat_messages_session_role_created');
    expect(migration).toContain(
      'ON public.chat_messages(session_id, role, created_at DESC)'
    );
    expect(migration).toContain('idx_chat_messages_assistant_created_id');
    expect(migration).toContain("WHERE role = 'assistant'");
    expect(migration).toContain(
      'idx_coaching_monitor_runs_running_checked_at'
    );
    expect(migration).toContain("WHERE status = 'running'");
  });

  it('scopes message-content search to the signed-in member sessions', () => {
    const route = read('src/app/api/chat/sessions/route.ts');

    expect(route).toContain("chat_sessions!inner(id)");
    expect(route).toContain(".eq('chat_sessions.user_id', user.id)");
  });

  it('crosses the memory boundary without seeding 81 rows every ten minutes', () => {
    const route = read('src/app/api/monitor/coaching/route.ts');

    expect(route).toContain('const MONITOR_HISTORY_PAIRS = 13;');
    expect(route).not.toContain('const MONITOR_HISTORY_PAIRS = 40;');
  });

  it('runs the coaching monitor four times a day without slowing AWAKES access checks', () => {
    const config = JSON.parse(read('vercel.json')) as {
      crons: Array<{ path: string; schedule: string }>;
    };

    expect(
      config.crons.find((cron) => cron.path === '/api/monitor/coaching')
        ?.schedule
    ).toBe('0 */6 * * *');
    expect(
      config.crons.find((cron) => cron.path === '/api/cron/awakes-access')
        ?.schedule
    ).toBe('*/10 * * * *');
  });
});
