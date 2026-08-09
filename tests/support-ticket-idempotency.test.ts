import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('support ticket delivery safety', () => {
  it('uses one submission key for browser retries and cleans incomplete records', () => {
    const route = fs.readFileSync(path.join(root, 'src/app/api/support/route.ts'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'src/app/support/page.tsx'), 'utf8');
    const migration = fs.readFileSync(
      path.join(
        root,
        'supabase/migrations/027_make_support_ticket_submissions_idempotent.sql'
      ),
      'utf8'
    );

    expect(route).toContain('submission_key: submissionKey');
    expect(route).toContain('isUniqueViolation(insertError)');
    expect(route).toContain('deleteIncompleteSupportTicket');
    expect(route.indexOf('if (submission_key)')).toBeLessThan(
      route.indexOf('const oneHourAgo')
    );
    expect(page).toContain("formData.append('submission_key', submissionKeyRef.current)");
    expect(migration).toContain('support_tickets_user_submission_key_unique');
  });
});
