import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('support ticket privacy boundary', () => {
  it('includes support ticket access rules in the fresh schema', () => {
    const schema = read('supabase/schema.sql');
    expect(schema).toContain('create table if not exists public.support_tickets');
    expect(schema).toContain('alter table public.support_tickets enable row level security;');
    expect(schema).toContain('create policy "Only admins can manage support tickets"');
  });

  it('removes unknown legacy policies before granting management access only to admins', () => {
    const migration = read('supabase/migrations/021_secure_support_ticket_access.sql');
    expect(migration).toContain('FROM pg_policies');
    expect(migration).toContain('REVOKE ALL ON TABLE public.support_tickets FROM anon, authenticated;');
    expect(migration).toContain('GRANT SELECT, UPDATE ON TABLE public.support_tickets TO authenticated;');
    expect(migration).toContain("profiles.role = 'admin'");
  });
});
