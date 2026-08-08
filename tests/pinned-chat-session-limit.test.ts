import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('pinned session limit', () => {
  it('enforces the limit with a per-member database lock', () => {
    const migration = fs.readFileSync(
      path.join(
        root,
        'supabase/migrations/026_enforce_pinned_chat_session_limit.sql'
      ),
      'utf8'
    );

    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF is_pinned');
    expect(migration).toContain('v_pinned_count >= 100');
  });
});
