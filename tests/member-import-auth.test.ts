import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'src/app/api/admin/import-members/route.ts'),
  'utf8'
);

describe('member import authorization', () => {
  it('requires a dedicated secret and bounds a bulk operation', () => {
    expect(source).toContain("process.env.MEMBER_IMPORT_SECRET || ''");
    expect(source).not.toContain('MYASP_WEBHOOK_SECRET');
    expect(source).toContain('const MAX_IMPORT_EMAILS = 500');
    expect(source).toContain('const importedEmails = new Set<string>()');
  });

  it('records pending entitlements without activating an existing account by email match', () => {
    expect(source).toContain(".from('pending_activations')");
    expect(source).not.toContain(".from('profiles')");
    expect(source).not.toContain("subscription_status: 'active'");
    expect(source).not.toContain('activated_existing');
  });

  it('does not reset a consumed entitlement when the same email is imported again', () => {
    expect(source).not.toContain('activated: false');
    expect(source).not.toContain('activated_at: null');
    expect(source).not.toContain('created_at: new Date()');
  });
});
