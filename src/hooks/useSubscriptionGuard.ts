'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { restoreSessionFromCookie } from '@/lib/restore-session';

/**
 * Hook that checks subscription status on the client-side
 * Guards against bypassing server middleware via client-side navigation
 */
export function useSubscriptionGuard() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const checkSubscription = async () => {
      try {
        // Get current user
        let {
          data: { user },
        } = await supabase.auth.getUser();

        // If no user found in localStorage, try restoring from cookie
        if (!user) {
          const restored = await restoreSessionFromCookie(supabase);
          if (restored) {
            const { data } = await supabase.auth.getUser();
            user = data.user;
          }
        }

        if (!user) {
          // Not logged in - redirect to login
          router.push('/login');
          return;
        }

        // Get user profile with subscription status
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('subscription_status, is_active, role, paid_test_credits')
          .eq('id', user.id)
          .single();

        if (error) {
          console.error('Failed to fetch profile:', error);
          router.push('/subscription-required');
          return;
        }

        // Admins always have access
        if (profile?.role === 'admin') {
          setAllowed(true);
          setLoading(false);
          return;
        }

        // Check if user has active subscription OR paid test credits
        const hasActiveSubscription = profile?.subscription_status === 'active' && profile?.is_active;
        const hasPaidTestCredits = (profile?.paid_test_credits || 0) > 0;

        if (!hasActiveSubscription && !hasPaidTestCredits) {
          router.push('/subscription-required');
          return;
        }

        // User has active subscription or paid test credits
        setAllowed(true);
        setLoading(false);
      } catch (err) {
        console.error('Subscription check error:', err);
        router.push('/subscription-required');
      }
    };

    checkSubscription();
  }, [router, supabase]);

  return { loading, allowed };
}
