import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('chat-session diagnosis ownership', () => {
  it('requires an attached diagnosis result to belong to the signed-in member', () => {
    const migration = fs.readFileSync(
      path.join(
        root,
        'supabase/migrations/024_enforce_chat_session_diagnosis_ownership.sql'
      ),
      'utf8'
    );

    expect(migration).toContain('DROP POLICY IF EXISTS "Users can create their own chat sessions"');
    expect(migration).toContain('WHERE id = chat_sessions.diagnosis_result_id');
    expect(migration).toContain('AND user_id = auth.uid()');
    expect(migration).toContain('ON public.chat_sessions FOR UPDATE');
    expect(migration).toContain('WITH CHECK');
  });
});
