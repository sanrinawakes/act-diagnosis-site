import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('member-intake table access', () => {
  it('removes public policies from the source migrations', () => {
    const freeUsers = read('supabase/migrations/005_add_free_users.sql');
    const pendingActivations = read('supabase/migrations/006_add_pending_activations.sql');
    expect(freeUsers).not.toContain('CREATE POLICY "Anyone can create free user"');
    expect(freeUsers).not.toContain('CREATE POLICY "Anon can select free_users"');
    expect(freeUsers).not.toContain('CREATE POLICY "Anon can update free_users"');
    expect(freeUsers).toContain('REVOKE ALL ON TABLE public.free_users FROM anon, authenticated;');
    expect(pendingActivations).not.toContain('CREATE POLICY "Service role full access on pending_activations"');
    expect(pendingActivations).toContain('REVOKE ALL ON TABLE public.pending_activations FROM anon, authenticated;');
  });

  it('locks down existing production tables in an idempotent migration', () => {
    const migration = read('supabase/migrations/015_lock_down_member_intake_tables.sql');
    expect(migration).toContain('DROP POLICY IF EXISTS "Anyone can create free user"');
    expect(migration).toContain('DROP POLICY IF EXISTS "Service role full access on pending_activations"');
    expect(migration).toContain('REVOKE ALL ON TABLE public.free_users FROM anon, authenticated;');
    expect(migration).toContain('REVOKE ALL ON TABLE public.pending_activations FROM anon, authenticated;');
  });
});
