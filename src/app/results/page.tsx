'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
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
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">読み込み中...</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <Header />
      <div className="min-h-screen p-6 sm:p-8">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl font-bold text-gray-900 mb-8">診断結果一覧</h1>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-900 p-4 rounded-lg mb-6">
              {error}
            </div>
          )}

          {results.length === 0 ? (
            <div className="bg-white border border-blue-200 rounded-lg p-12 text-center">
              <p className="text-xl text-gray-600 mb-6">
                まだ診断を受けていません
              </p>
              <Link
                href="/diagnosis"
                className="inline-block bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold py-3 px-8 rounded-lg transition-all duration-200 transform hover:scale-105"
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
                  <div className="bg-white border border-blue-200 hover:border-blue-400 rounded-lg p-6 transition-all duration-200 transform hover:scale-105 hover:shadow-lg">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <div className="flex items-center gap-4 mb-2">
                          <div className="text-5xl font-bold text-transparent bg-gradient-to-r from-blue-600 via-pink-500 to-blue-500 bg-clip-text">
                            {result.type_code}
                          </div>
                          <div className="flex flex-col gap-2">
                            <span className="inline-block bg-gradient-to-r from-blue-500 to-blue-600 text-white px-4 py-2 rounded-full font-semibold text-sm">
                              {levelNames[result.consciousness_level]}
                            </span>
                          </div>
                        </div>
                        <p className="text-gray-600">
                          {typeNames[result.type_code] || result.type_code}
                        </p>
                      </div>
                    </div>

                    <div className="text-sm text-gray-500">
                      {new Date(result.created_at).toLocaleDateString('ja-JP', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>

                    <div className="mt-4 flex items-center text-blue-600 group-hover:text-blue-700 font-semibold">
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
              className="text-blue-600 hover:text-blue-700 font-semibold transition-colors"
            >
              ← ホームに戻る
            </Link>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
