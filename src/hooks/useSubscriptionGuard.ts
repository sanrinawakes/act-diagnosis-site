'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { restoreSessionFromCookie } from '@/lib/restore-session';
import { withAuthTimeout } from '@/lib/auth-flow';
import { hasCoachingAccess, hasPaidDiagnosisAccess } from '@/lib/coaching-access';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Hook that checks subscription status on the client-side
 * Guards against bypassing server middleware via client-side navigation
 */
export function useSubscriptionGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const checkSubscription = async () => {
      try {
        // Get current user
        let {
          data: { user },
        } = await withAuthTimeout(supabase.auth.getUser());

        // If no user found in localStorage, try restoring from cookie
        if (!user) {
          const restored = await withAuthTimeout(restoreSessionFromCookie(supabase));
          if (restored) {
            const { data } = await withAuthTimeout(supabase.auth.getUser());
            user = data.user;
          }
        }

        if (!user) {
          // Not logged in - redirect to login
          setLoading(false);
          router.push('/login');
          return;
        }

        // Get user profile with subscription status. Retry once so a temporary
        // mobile network delay does not incorrectly show the paid-content block.
        let { data: profile, error } = await withAuthTimeout(
          supabase
            .from('profiles')
            .select('subscription_status, is_active, role, paid_test_credits, awakes_access_expires_at')
            .eq('id', user.id)
            .single(),
          '会員状態の確認に時間がかかりすぎました。'
        );

        if (error) {
          await delay(800);
          const retry = await withAuthTimeout(
            supabase
              .from('profiles')
              .select('subscription_status, is_active, role, paid_test_credits, awakes_access_expires_at')
              .eq('id', user.id)
              .single(),
            '会員状態の再確認に時間がかかりすぎました。'
          );
          profile = retry.data;
          error = retry.error;
        }

        if (error) {
          console.error('Failed to fetch profile:', error);
          setLoading(false);
          router.push('/subscription-required');
          return;
        }

        const hasAccess = pathname.startsWith('/coaching')
          ? hasCoachingAccess(profile)
          : hasPaidDiagnosisAccess(profile);
        if (!hasAccess) {
          setLoading(false);
          router.push('/subscription-required');
          return;
        }

        // Coaching requires a current AWAKES term. Paid diagnosis credits are
        // accepted only on diagnosis/results routes.
        setAllowed(true);
        setLoading(false);
      } catch (err) {
        console.error('Subscription check error:', err);
        setLoading(false);
        router.push('/subscription-required');
      }
    };

    checkSubscription();
  }, [pathname, router, supabase]);

  return { loading, allowed };
}
