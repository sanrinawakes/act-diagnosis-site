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
    expect(source).toContain('new Set(emails)');
  });
});
