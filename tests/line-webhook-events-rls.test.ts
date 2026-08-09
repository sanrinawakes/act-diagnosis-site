import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/020_dedupe_line_webhook_events.sql'),
  'utf8'
);
const route = readFileSync(
  resolve(process.cwd(), 'src/app/api/line/webhook/route.ts'),
  'utf8'
);

describe('LINE webhook duplicate and credential boundaries', () => {
  it('restricts the idempotency ledger and its RPCs to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.line_webhook_events FROM anon, authenticated;'
    );
    expect(migration).toContain('ON CONFLICT (event_key) DO UPDATE');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.claim_line_webhook_event(text, text, text)\n  TO service_role;'
    );
  });

  it('acknowledges verified events before slow AI generation and only runs claimed events', () => {
    expect(route).toContain('after(async () => {');
    expect(route).toContain('claimLineWebhookEvent');
    expect(route).toContain("status: 'accepted'");
  });
});
