import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const customerFacingRoutes = [
  'src/app/api/attachments/route.ts',
  'src/app/api/chat/route.ts',
  'src/app/api/chat/messages/route.ts',
  'src/app/api/chat/sessions/route.ts',
  'src/app/api/free/chat/route.ts',
  'src/app/api/free/diagnosis/route.ts',
  'src/app/api/myasp/cancel/route.ts',
  'src/app/api/myasp/payment/route.ts',
];

describe('customer error boundaries', () => {
  it.each(customerFacingRoutes)(
    '%s never returns a caught internal Error message to the caller',
    (route) => {
      const source = readFileSync(resolve(process.cwd(), route), 'utf8');
      const responses = Array.from(
        source.matchAll(/return\s+NextResponse\.json\(([\s\S]{0,450}?)\);/g),
        (match) => match[1]
      );

      expect(responses.length).toBeGreaterThan(0);
      for (const response of responses) {
        expect(response).not.toMatch(
          /error\s*:\s*error\s+instanceof\s+Error\s*\?\s*error\.message/
        );
        expect(response).not.toMatch(
          /details\s*:\s*error\s+instanceof\s+Error/
        );
      }
    }
  );
});

describe('free coaching guardrails', () => {
  it('does not retain a placeholder link in the customer-facing prompt', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/api/free/chat/route.ts'),
      'utf8'
    );
    expect(source).not.toContain('https://example.com/study-session');
  });

  it.each([
    'src/app/api/free/chat/route.ts',
    'src/app/api/free/diagnosis/route.ts',
  ])('%s authenticates the browser user before changing free-user data', (route) => {
    const source = readFileSync(resolve(process.cwd(), route), 'utf8');
    expect(source).toContain("createServerClient");
    expect(source).toContain('auth.getUser()');
  });
});

describe('authentication error boundary', () => {
  it('does not pass Supabase or OAuth error text into the login redirect', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/api/auth/callback/route.ts'),
      'utf8'
    );
    expect(source).not.toContain("'ログインリンクの検証に失敗しました: ' + error.message");
    expect(source).not.toContain("'セッション取得に失敗しました: ' + error.message");
    expect(source).not.toContain('`ログイン連携が完了しませんでした: ${providerError}`');
  });
});
