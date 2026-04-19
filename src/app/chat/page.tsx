'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function ChatRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = searchParams.get('code');
    const session = searchParams.get('session');
    const qs = new URLSearchParams();
    if (code) qs.set('code', code);
    if (session) qs.set('session', session);
    const q = qs.toString();
    router.replace(q ? `/coaching?${q}` : '/coaching');
  }, [router, searchParams]);

  return null;
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatRedirectInner />
    </Suspense>
  );
}
