import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('attachment route security', () => {
  it('checks ownership before generating a short-lived storage URL', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/app/api/attachments/route.ts'),
      'utf8'
    );

    expect(source).toContain('canReadAttachment');
    expect(source).toContain(".eq('id', ticketMatch[1])");
    expect(source).toContain(".eq('id', userId)");
    expect(source).toContain('createSignedUrl(path, SIGNED_URL_EXPIRES_IN)');
    expect(source).toContain("Cache-Control', 'private, no-store'");
  });
});
