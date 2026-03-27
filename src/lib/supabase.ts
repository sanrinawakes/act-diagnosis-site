import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

// Singleton instance to ensure auth state is shared across all components
let supabaseInstance: SupabaseClient | null = null;

/**
 * Create a Supabase client for browser-side usage (singleton)
 * Uses @supabase/ssr's createBrowserClient to store auth tokens in cookies,
 * matching the middleware's createServerClient which reads from cookies.
 */
export function createClient() {
  if (supabaseInstance) {
    return supabaseInstance;
  }
  supabaseInstance = createBrowserClient(supabaseUrl, supabaseAnonKey);
  return supabaseInstance;
}
