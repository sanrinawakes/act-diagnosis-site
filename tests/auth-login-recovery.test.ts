import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('login recovery', () => {
  it('explains the correct recovery paths after an invalid password', () => {
    const translations = fs.readFileSync(path.join(root, 'src/lib/i18n.tsx'), 'utf8');

    expect(translations).toContain('Googleで登録した方は、上の「Googleでログイン」を押してください。');
    expect(translations).toContain('下の「メールでログインリンクを受け取る」をお使いください。');
    expect(translations).toContain('If you registered with Google, use “Sign in with Google” above.');
  });

  it('does not create a new account from the recovery-only magic-link action', () => {
    const form = fs.readFileSync(path.join(root, 'src/app/login/LoginForm.tsx'), 'utf8');

    expect(form).toContain('shouldCreateUser: false');
    expect(form).toContain('Googleログインが使えない方・パスワードが分からない方はこちら');
  });

  it('uses a token-hash callback that does not depend on the requesting browser', () => {
    const template = fs.readFileSync(
      path.join(root, 'supabase/email-templates/magic-link.html'),
      'utf8'
    );
    const callback = fs.readFileSync(
      path.join(root, 'src/app/api/auth/callback/route.ts'),
      'utf8'
    );

    expect(template).toContain('token_hash={{ .TokenHash }}');
    expect(template).toContain('type=email');
    expect(template).not.toContain('.ConfirmationURL');
    expect(callback).toContain('supabase.auth.verifyOtp');
    expect(callback).toContain('token_hash: tokenHash');
  });
});
