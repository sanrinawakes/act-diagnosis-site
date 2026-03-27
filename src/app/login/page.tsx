'use client';

import dynamic from 'next/dynamic';

// SSRを無効化してhydration不一致を完全に排除
// ログインページはSEO不要なのでSSR無しで問題ない
const LoginForm = dynamic(() => import('./LoginForm'), {
  ssr: false,
  loading: () => (
    <main className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-blue-100 via-blue-50 to-blue-100">
      <div className="w-full max-w-md">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl p-8 border border-blue-200/60 shadow-xl">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">ログイン</h1>
            <p className="text-gray-600">ACTIへようこそ</p>
          </div>
          <div className="mt-8 flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-400"></div>
          </div>
        </div>
      </div>
    </main>
  ),
});

export default function LoginPage() {
  return <LoginForm />;
}
