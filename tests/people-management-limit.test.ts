import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('people management limit', () => {
  it('serializes inserts before checking the hard 100-person limit', () => {
    const migration = fs.readFileSync(
      path.join(root, 'supabase/migrations/003_add_people_management.sql'),
      'utf8'
    );

    expect(migration).toContain('LOCK TABLE people_management IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain('COUNT(*) FROM people_management) >= 100');
  });
});
