import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const cookieMutationRoutes = [
  'src/app/api/admin/users/route.ts',
  'src/app/api/admin/settings/route.ts',
  'src/app/api/admin/support/reply/route.ts',
  'src/app/api/referral/redeem/route.ts',
  'src/app/api/free/diagnosis/route.ts',
  'src/app/api/free/chat/route.ts',
];

describe('cookie-authenticated mutation routes', () => {
  it('enforces the application origin before changing data or consuming a quota', () => {
    for (const file of cookieMutationRoutes) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).toContain("import { hasAllowedRequestOrigin } from '@/lib/request-origin'");
      expect(source).toContain('hasAllowedRequestOrigin(request)');
    }
  });

  it('does not allow anonymous client-error reports to trigger operator alerts', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/app/api/monitor/coaching/client-error/route.ts'),
      'utf8'
    );
    expect(source).toContain("auth.status !== 'authenticated' || !auth.userId");
  });
});
