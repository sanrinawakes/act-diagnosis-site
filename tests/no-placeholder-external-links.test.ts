import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const publicFreePages = [
  'src/app/free/page.tsx',
  'src/app/free/results/page.tsx',
  'src/app/free/coaching/page.tsx',
];

describe('public free pages', () => {
  it('does not send customers to placeholder domains', () => {
    for (const file of publicFreePages) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toContain('example.com');
    }
  });
});
