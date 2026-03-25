'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

interface AdminGuardProps {
  children: React.ReactNode;
}

export default function AdminGuard({ children }: AdminGuardProps) {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const checkAdmin = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          setIsAdmin(false);
          router.push('/login');
          return;
        }

        // Fetch user profile to check role
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (error || !profile || profile.role !== 'admin') {
          setIsAdmin(false);
          router.push('/');
          return;
        }

        setIsAdmin(true);
      } catch (error) {
        console.error('Admin check failed:', error);
        setIsAdmin(false);
        router.push('/');
      }
    };

    checkAdmin();
  }, [router, supabase]);

  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
          <p className="text-gray-500">読み込み中...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-xl text-red-500 font-semibold mb-4">管理者権限が必要です</p>
          <p className="text-gray-500">このページにアクセスする権限がありません。</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
