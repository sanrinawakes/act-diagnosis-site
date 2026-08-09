import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('LINE message burst limiter', () => {
  it('uses a row lock and keeps rate reservations server-only', () => {
    const migration = fs.readFileSync(
      path.join(
        root,
        'supabase/migrations/025_rate_limit_line_message_bursts.sql'
      ),
      'utf8'
    );

    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('REVOKE ALL ON TABLE public.line_message_rate_windows FROM anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.reserve_line_message_rate');
    expect(migration).toContain('TO service_role');
  });
});
