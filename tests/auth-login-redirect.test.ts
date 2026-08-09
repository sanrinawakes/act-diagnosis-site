import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('legacy server password login', () => {
  it('does not write raw authentication tokens into document.cookie', () => {
    const route = fs.readFileSync(
      path.join(root, 'src/app/api/auth/login/route.ts'),
      'utf8'
    );
    const form = fs.readFileSync(
      path.join(root, 'src/app/login/LoginForm.tsx'),
      'utf8'
    );

    expect(route).not.toContain('document.cookie');
    expect(route).not.toContain('auth/v1/token?grant_type=password');
    expect(route).toContain('status: 405');
    expect(form).not.toContain('action="/api/auth/login"');
  });
});
