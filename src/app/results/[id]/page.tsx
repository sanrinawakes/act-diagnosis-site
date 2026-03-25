'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { createClient } from '@/lib/supabase';
import { DiagnosisResult } from '@/lib/types';
import { typeNames, levelNames, axisDescriptions } from '@/data/type-names';

export default function ResultDetailPage() {
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const params = useParams();
  const supabase = createClient();
  const resultId = params.id as string;

  useEffect(() => {
    const fetchResult = async () => {
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
          .eq('id', resultId)
          .eq('user_id', user.id)
          .single();

        if (error) throw error;
        if (!data) throw new Error('診断結果が見つかりません');

        setResult(data);
      } catch (err) {
        console.error('Failed to fetch result:', err);
        setError('診断結果の読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchResult();
  }, [router, supabase, resultId]);

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

  if (error || !result) {
    return (
      <AuthGuard>
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 p-6 sm:p-8">
          <div className="max-w-4xl mx-auto">
            <div className="bg-red-900/30 border border-red-700 text-red-200 p-6 rounded-lg mb-6">
              {error || '診断結果が見つかりません'}
            </div>
            <Link
              href="/results"
              className="text-indigo-400 hover:text-indigo-300 font-semibold transition-colors"
            >
              ← 結果一覧に戻る
            </Link>
          </div>
        </div>
      </AuthGuard>
    );
  }

  const typeCode = result.type_code;
  const axis1 = typeCode[0];
  const axis2 = typeCode[1];
  const axis3 = typeCode[2];

  return (
    <AuthGuard>
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 p-6 sm:p-8">
        <div className="max-w-4xl mx-auto">
          {/* Header with type code and level */}
          <div className="mb-8">
            <Link
              href="/results"
              className="text-indigo-400 hover:text-indigo-300 font-semibold transition-colors mb-6 inline-block"
            >
              ← 結果一覧に戻る
            </Link>

            <div className="bg-gradient-to-br from-indigo-900/50 to-purple-900/50 border border-indigo-700/50 rounded-lg p-8 mb-8">
              <div className="flex flex-col gap-6">
                <div className="flex items-end gap-6">
                  <div>
                    <p className="text-gray-400 text-sm mb-2">タイプコード</p>
                    <div className="text-7xl font-bold text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text">
                      {typeCode}
                    </div>
                  </div>

                  <div>
                    <p className="text-gray-400 text-sm mb-2">意識レベル</p>
                    <div className="flex items-center gap-3">
                      <div className="text-5xl font-bold text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text">
                        {result.consciousness_level}
                      </div>
                      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-2 rounded-lg font-semibold">
                        {levelNames[result.consciousness_level]}
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-2xl font-semibold text-indigo-300 mb-2">
                    {typeNames[typeCode] || typeCode}
                  </p>
                  <p className="text-gray-400">
                    {new Date(result.created_at).toLocaleDateString('ja-JP', {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Axis Explanations */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-6">3つの軸の説明</h2>

            <div className="grid gap-4 md:grid-cols-3">
              {/* Axis 1 */}
              <div className="bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-700/50 rounded-lg p-6">
                <p className="text-indigo-300 font-semibold mb-2">
                  1文字目: {axisDescriptions.axis1.description}
                </p>
                <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text mb-3">
                  {axis1}
                </p>
                <p className="text-gray-300">
                  {axis1 === 'S'
                    ? axisDescriptions.axis1.S
                    : axis1 === 'P'
                      ? axisDescriptions.axis1.P
                      : axisDescriptions.axis1.M}
                </p>
                <p className="text-gray-400 text-sm mt-3">
                  {axis1 === 'S'
                    ? 'あなたは内向的なエネルギーを持つ人です。深い思考と内省を重視します。'
                    : axis1 === 'P'
                      ? 'あなたは外向的なエネルギーを持つ人です。行動と周囲との関わりを重視します。'
                      : 'あなたはバランスの取れたエネルギーを持つ人です。状況に応じて柔軟に対応します。'}
                </p>
              </div>

              {/* Axis 2 */}
              <div className="bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-700/50 rounded-lg p-6">
                <p className="text-indigo-300 font-semibold mb-2">
                  2文字目: {axisDescriptions.axis2.description}
                </p>
                <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text mb-3">
                  {axis2}
                </p>
                <p className="text-gray-300">
                  {axis2 === 'V'
                    ? axisDescriptions.axis2.V
                    : axis2 === 'G'
                      ? axisDescriptions.axis2.G
                      : axisDescriptions.axis2.M}
                </p>
                <p className="text-gray-400 text-sm mt-3">
                  {axis2 === 'V'
                    ? 'あなたは理想や価値観を大切にする理想型です。'
                    : axis2 === 'G'
                      ? 'あなたは現実や実用性を重視する現実型です。'
                      : 'あなたはバランス感覚に優れたバランス型です。'}
                </p>
              </div>

              {/* Axis 3 */}
              <div className="bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-700/50 rounded-lg p-6">
                <p className="text-indigo-300 font-semibold mb-2">
                  3文字目: {axisDescriptions.axis3.description}
                </p>
                <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text mb-3">
                  {axis3}
                </p>
                <p className="text-gray-300">
                  {axis3 === 'A'
                    ? axisDescriptions.axis3.A
                    : axis3 === 'E'
                      ? axisDescriptions.axis3.E
                      : axisDescriptions.axis3.M}
                </p>
                <p className="text-gray-400 text-sm mt-3">
                  {axis3 === 'A'
                    ? 'あなたは論理的で客観的な判断を重視する論理型です。'
                    : axis3 === 'E'
                      ? 'あなたは感情や共感を大切にする感情型です。'
                      : 'あなたは論理と感情のバランスを取る中立型です。'}
                </p>
              </div>
            </div>
          </div>

          {/* Consciousness Level Details */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-6">意識レベルについて</h2>

            <div className="bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-700/50 rounded-lg p-6">
              <p className="text-indigo-300 font-semibold mb-3 text-lg">
                レベル {result.consciousness_level}: {levelNames[result.consciousness_level]}
              </p>

              <p className="text-gray-300 leading-relaxed">
                {result.consciousness_level === 1
                  ? '防衛レベルでは、あなたは困難や脅威から身を守ることに集中しています。安全と安心を最優先とし、変化よりも現状維持を好みます。'
                  : result.consciousness_level === 2
                    ? '著しい葛藤レベルでは、あなたは内的な矛盾や対立を感じています。異なる価値観や欲求のバランスを取ることに苦労しています。'
                    : result.consciousness_level === 3
                      ? '自立レベルでは、あなたは自分の価値観に基づいて独立して判断し、行動できます。自己責任と個人の成長を重視しています。'
                      : result.consciousness_level === 4
                        ? '調和レベルでは、あなたは個人の欲求と周囲との関係のバランスを取ることができます。共感と協働を大切にしながらも、自分の目標を追求します。'
                        : result.consciousness_level === 5
                          ? '創造レベルでは、あなたは新しい可能性を見出し、他者にインスピレーションを与えることができます。個人の成長と周囲への貢献の統合を実現しています。'
                          : '解脱（視野の超越）レベルでは、あなたはあらゆる二項対立を超え、より大きな視野を持って世界を理解しています。普遍的な真理と個別の現象の関連を知覚します。'}
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-4 sm:flex-row">
            <Link
              href={`/chat?code=${typeCode}-${result.consciousness_level}`}
              className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-3 px-6 rounded-lg text-center transition-all duration-200 transform hover:scale-105 shadow-lg hover:shadow-xl hover:shadow-indigo-500/30"
            >
              AIコーチングを受ける
            </Link>

            <Link
              href="/diagnosis"
              className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-semibold py-3 px-6 rounded-lg text-center transition-all duration-200 transform hover:scale-105 shadow-lg hover:shadow-xl hover:shadow-purple-500/30"
            >
              もう一度診断する
            </Link>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
