import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('chat message role boundary', () => {
  it('allows browser clients to insert only user input in a fresh schema', () => {
    const schema = read('supabase/schema.sql');
    expect(schema).toContain('create policy "Users can create their own chat inputs"');
    expect(schema).toContain("with check (role = 'user' and exists (");
    expect(schema).not.toContain('create policy "Users can create messages in their chat sessions"');
  });

  it('replaces the legacy broad insert policy for deployed databases', () => {
    const migration = read('supabase/migrations/017_lock_down_chat_message_roles.sql');
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can create messages in their chat sessions"');
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can create their own chat inputs"');
    expect(migration).toContain("role = 'user'");
  });
});
