import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Parse the Supabase auth cookie and restore the session into the JS client.
 * This bridges the gap between server-side cookie auth (set by /api/auth/login)
 * and the client-side Supabase JS client (which uses localStorage by default).
 *
 * Returns true if a session was successfully restored from the cookie.
 */
export async function restoreSessionFromCookie(supabase: SupabaseClient): Promise<boolean> {
  try {
    if (typeof document === 'undefined') return false;

    // Find the sb-*-auth-token cookie
    const cookies = document.cookie.split(';');
    const authCookie = cookies.find(
      (c) => c.trim().startsWith('sb-') && c.includes('-auth-token=')
    );
    if (!authCookie) return false;

    const cookieValue = decodeURIComponent(authCookie.split('=').slice(1).join('='));
    const sessionData = JSON.parse(cookieValue);

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
