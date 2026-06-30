import type { SupabaseClient } from '@supabase/supabase-js';

type CookieSession = {
  access_token: string;
  refresh_token?: string;
};

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;

  const cookies = document.cookie
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .map((cookie) => {
      const separatorIndex = cookie.indexOf('=');
      return {
        name: separatorIndex >= 0 ? cookie.slice(0, separatorIndex) : cookie,
        value: separatorIndex >= 0 ? cookie.slice(separatorIndex + 1) : '',
      };
    });

  const direct = cookies.find((cookie) => cookie.name === name);
  if (direct) return direct.value;

  const chunks = cookies
    .filter((cookie) => cookie.name.startsWith(`${name}.`))
    .sort((a, b) => {
      const aIndex = Number(a.name.split('.').pop() || 0);
      const bIndex = Number(b.name.split('.').pop() || 0);
      return aIndex - bIndex;
    });

  if (chunks.length === 0) return null;
  return chunks.map((cookie) => cookie.value).join('');
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return decodeURIComponent(
    Array.from(atob(padded))
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('')
  );
}

function parseSessionCookie(rawValue: string): CookieSession | null {
  try {
    const decodedValue = decodeURIComponent(rawValue);
    const jsonText = decodedValue.startsWith('base64-')
      ? decodeBase64Url(decodedValue.slice('base64-'.length))
      : decodedValue;
    const sessionData = JSON.parse(jsonText);

    if (sessionData?.access_token) {
      return {
        access_token: sessionData.access_token,
        refresh_token: sessionData.refresh_token,
      };
    }

    if (Array.isArray(sessionData) && typeof sessionData[0] === 'string') {
      return {
        access_token: sessionData[0],
        refresh_token: typeof sessionData[1] === 'string' ? sessionData[1] : undefined,
      };
    }

    if (sessionData?.currentSession?.access_token) {
      return {
        access_token: sessionData.currentSession.access_token,
        refresh_token: sessionData.currentSession.refresh_token,
      };
    }
  } catch (error) {
    console.error('Failed to parse auth cookie:', error);
  }

  return null;
}

export function getSessionFromCookie(): CookieSession | null {
  if (typeof document === 'undefined') return null;

  const cookieNames = document.cookie
    .split(';')
    .map((cookie) => cookie.trim().split('=')[0])
    .filter((name) => name.startsWith('sb-') && name.includes('-auth-token'))
    .map((name) => name.replace(/\.\d+$/, ''));

  for (const cookieName of Array.from(new Set(cookieNames))) {
    const rawValue = readCookie(cookieName);
    if (!rawValue) continue;

    const session = parseSessionCookie(rawValue);
    if (session?.access_token) return session;
  }

  return null;
}

/**
 * Parse the Supabase auth cookie and restore the session into the JS client.
 * This bridges the gap between server-side cookie auth (set by /api/auth/login)
 * and the client-side Supabase JS client (which uses localStorage by default).
 *
 * Returns true if a session was successfully restored from the cookie.
 */
export async function restoreSessionFromCookie(supabase: SupabaseClient): Promise<boolean> {
  try {
    const sessionData = getSessionFromCookie();

    if (sessionData?.access_token && sessionData?.refresh_token) {
      const { error } = await supabase.auth.setSession({
        access_token: sessionData.access_token,
        refresh_token: sessionData.refresh_token,
      });
      if (error) {
        console.error('Failed to restore session from cookie:', error);
        return false;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
