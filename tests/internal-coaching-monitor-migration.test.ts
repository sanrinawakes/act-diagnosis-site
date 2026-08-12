import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/029_add_internal_coaching_monitor.sql'),
  'utf8'
);

describe('internal coaching monitor migration', () => {
  it('permits exactly one service-only monitor and excludes only it from customer expiry', () => {
    expect(source).toContain('is_internal_coaching_monitor boolean NOT NULL DEFAULT false');
    expect(source).toContain('profiles_single_internal_coaching_monitor');
    expect(source).toContain('WHERE is_internal_coaching_monitor = true');
    expect(source).toContain('AND is_internal_coaching_monitor = false');
    expect(source).toContain('protect_internal_coaching_monitor_flag');
    expect(source).toContain("current_user NOT IN ('postgres', 'service_role', 'supabase_admin')");
    expect(source).toContain('internal coaching monitor flag is service-managed');
  });
});
