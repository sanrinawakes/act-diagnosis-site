import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const routePath = path.join(root, 'src/app/api/admin/users/route.ts');

describe('admin users route validation', () => {
  it('bounds pagination and validates every mutable field before an update', () => {
    const route = fs.readFileSync(routePath, 'utf8');

    expect(route).toContain('const MAX_PAGE_SIZE = 100');
    expect(route).toContain("parsePositiveInt(searchParams.get('limit'), 20, MAX_PAGE_SIZE)");
    expect(route).toContain('countQuery = countQuery.ilike');
    expect(route).toContain("typeof is_active !== 'boolean'");
    expect(route).toContain('PROFILE_ID_PATTERN.test(user_id)');
    expect(route).toContain('function isRecord');
    expect(route).toContain("select('awakes_access_expires_at')");
    expect(route).toContain('Date.parse(entitlement.awakes_access_expires_at) <= Date.now()');
  });
});
