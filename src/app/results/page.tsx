'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { createClient } from '@/lib/supabase';
import { DiagnosisResult } from '@/lib/types';
import { typeNames, levelNames } from '@/data/type-names';

export default function ResultsPage() {
  const [results, setResults] = useState<DiagnosisResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const fetchResults = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          router.push('/login');
          return;
        }

        const { data, error } = await supabase
          .from('diagnosis_results')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (error) throw error;

        setResults(data || []);
      } catch (err) {
        console.error('Failed to fetch results:', err);
        setError('診断結果の読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchResults();
  }, [router, supabase]);

  if (loading) {
    return (
      <AuthGuard>
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            <p className="text-gray-300">読み込み中...</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 p-6 sm:p-8">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl font-bold text-white mb-8">診断結果一覧</h1>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-200 p-4 rounded-lg mb-6">
              {error}
            </div>
          )}

          {results.length === 0 ? (
            <div className="bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-700/50 rounded-lg p-12 text-center">
              <p className="text-xl text-gray-300 mb-6">
                まだ診断を受けていません
              </p>
              <Link
                href="/diagnosis"
                className="inline-block bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-3 px-8 rounded-lg transition-all duration-200 transform hover:scale-105"
              >
                診断を開始する
              </Link>
            </div>
          ) : (
            <div className="grid gap-6">
              {results.map((result) => (
                <Link
                  key={result.id}
                  href={`/results/${result.id}`}
                  className="block group"
                >
                  <div className="bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-700/50 hover:border-indigo-600/80 rounded-lg p-6 transition-all duration-200 transform hover:scale-105 hover:shadow-xl hover:shadow-indigo-500/20">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <div className="flex items-center gap-4 mb-2">
                          <div className="text-5xl font-bold text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text">
                            {result.type_code}
                          </div>
                          <div className="flex flex-col gap-2">
                            <span className="inline-block bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-2 rounded-full font-semibold text-sm">
                              {levelNames[result.consciousness_level]}
                            </span>
                          </div>
                        </div>
                        <p className="text-gray-300">
                          {typeNames[result.type_code] || result.type_code}
                        </p>
                      </div>
                    </div>

                    <div className="text-sm text-gray-400">
                      {new Date(result.created_at).toLocaleDateString('ja-JP', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>

                    <div className="mt-4 flex items-center text-indigo-400 group-hover:text-indigo-300 font-semibold">
                      詳細を見る →
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          <div className="mt-8">
            <Link
              href="/"
              className="text-indigo-400 hover:text-indigo-300 font-semibold transition-colors"
            >
              ← ホームに戻る
            </Link>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
