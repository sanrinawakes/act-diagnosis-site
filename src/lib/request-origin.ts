import type { NextRequest } from 'next/server';

export function hasAllowedRequestOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  const allowedOrigins = new Set([request.nextUrl.origin]);
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (configuredSiteUrl) {
    try {
      allowedOrigins.add(new URL(configuredSiteUrl).origin);
    } catch {
      // An invalid optional configuration must not widen the allowed origins.
    }
  }

  return allowedOrigins.has(origin);
}
