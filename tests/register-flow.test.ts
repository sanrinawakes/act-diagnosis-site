import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('register flow', () => {
  it('新規登録画面はSupabase確認メールに直接依存しない', () => {
    const registerPage = readFileSync('src/app/register/page.tsx', 'utf8');

    expect(registerPage).toContain("fetch('/api/auth/register'");
    expect(registerPage).not.toContain('supabase.auth.signUp');
    expect(registerPage).toContain('確認メールを待たずに');
  });

  it('登録APIはメール確認済みユーザーとして作成する', () => {
    const registerRoute = readFileSync(
      'src/app/api/auth/register/route.ts',
      'utf8'
    );

    expect(registerRoute).toContain('admin.auth.admin.createUser');
    expect(registerRoute).toContain('email_confirm: true');
    expect(registerRoute).toContain('既に登録されています');
  });
});
