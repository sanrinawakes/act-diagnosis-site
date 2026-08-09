import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('profile privilege boundary', () => {
  it('removes direct member profile updates from the base schema', () => {
    const schema = read('supabase/schema.sql');
    expect(schema).not.toContain('create policy "Users can update their own profile"');
  });

  it('revokes direct profile updates for browser roles in production migrations', () => {
    const migration = read('supabase/migrations/016_lock_down_profile_updates.sql');
    expect(migration).toContain('REVOKE UPDATE ON TABLE public.profiles FROM anon, authenticated;');
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;');
  });
});
