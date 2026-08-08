import { describe, expect, it } from 'vitest';
import config from '../next.config';

describe('baseline security headers', () => {
  it('sets non-breaking browser protections for every route', async () => {
    const configuredHeaders = config.headers;
    expect(configuredHeaders).toBeTypeOf('function');
    if (!configuredHeaders) {
      throw new Error('Next.js security headers are not configured');
    }
    const routes = await configuredHeaders();
    expect(routes).toHaveLength(1);
    expect(routes[0].source).toBe('/:path*');
    expect(routes[0].headers).toEqual(
      expect.arrayContaining([
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        {
          key: 'Referrer-Policy',
          value: 'strict-origin-when-cross-origin',
        },
      ])
    );
  });
});
