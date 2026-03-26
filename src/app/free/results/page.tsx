'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';

interface DiagnosisResult {
  level: 1 | 2;
  typeCode: string;
}

export default function FreeResultsPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const savedEmail = localStorage.getItem('free_user_email');
    if (!savedEmail) {
      router.push('/free');
      return;
    }
    setEmail(savedEmail);

    const savedResult = localStorage.getItem('free_diagnosis_result');
    if (!savedResult) {
      router.push('/free/diagnosis');
      return;
    }

    try {
      const parsedResult = JSON.parse(savedResult);
      setResult(parsedResult);
      setInitialized(true);
    } catch (error) {
      console.error('Failed to parse diagnosis result:', error);
      router.push('/free/diagnosis');
    }
  }, [router]);

  if (!initialized || !result) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
      </div>
    );
  }

  const getLevelDescription = (level: 1 | 2) => {
    if (level === 1) {
      return {
        title: 'レベル1：防衛レベル',
        description:
          '変化や困難から身を守ることに集中している状態です。安全と安心が最優先になっています。',
        color: 'from-red-500 to-orange-500',
      };
    } else {
      return {
        title: 'レベル2：葛藤レベル',
        description:
          '内的な矛盾や葛藤を感じている状態です。異なる価値観や欲求のバランスに苦労しています。',
        color: 'from-yellow-500 to-amber-500',
      };
    }
  };

  const levelInfo = getLevelDescription(result.level);

  return (
    <main className="min-h-screen">
      <Header />

      <div className="relative overflow-hidden">
        {/* Background decorative elements */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob"></div>
          <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000"></div>
        </div>

        {/* Content */}
        <div className="relative z-10 px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="max-w-3xl mx-auto">
            {/* Result Card */}
            <div className="bg-white border-2 border-blue-200 rounded-2xl p-8 sm:p-12 mb-8 shadow-lg">
              <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-8 text-center">
                診断結果
              </h1>

              {/* Level Badge */}
              <div
                className={`bg-gradient-to-r ${levelInfo.color} rounded-xl p-8 mb-8 text-white text-center`}
              >
                <h2 className="text-2xl sm:text-3xl font-bold mb-3">{levelInfo.title}</h2>
                <p className="text-base sm:text-lg">{levelInfo.description}</p>
              </div>

              {/* Info Message */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-8">
                <p className="text-gray-700 text-center">
                  この簡易診断では15問から意識レベルを判定しました。
                </p>
              </div>

              {/* Type Info */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mb-8">
                <p className="text-gray-700 text-center">
                  <span className="font-semibold">タイプコード:</span> {result.typeCode}
                </p>
              </div>

              {/* CTA Buttons */}
              <div className="space-y-4 mb-8">
                <Link
                  href="/free/coaching"
                  className="block w-full py-4 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold rounded-lg transition-all duration-300 shadow-lg text-center"
                >
                  AIコーチに相談する（1日3回まで無料）
                </Link>
                <Link
                  href="#study-session"
                  className="block w-full py-4 px-6 bg-white border-2 border-blue-500 hover:bg-blue-50 text-blue-600 font-semibold rounded-lg transition-all duration-300 text-center"
                >
                  もっと詳しい診断を受ける
                </Link>
              </div>
            </div>

            {/* Teaser Section */}
            <div
              id="study-session"
              className="bg-gradient-to-r from-purple-50 to-pink-50 border-2 border-purple-200 rounded-2xl p-8 sm:p-12"
            >
              <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-6">
                フルテストを試してみませんか？
              </h2>

              <div className="space-y-6 mb-8">
                <div className="flex gap-4">
                  <div className="text-3xl flex-shrink-0">📊</div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">27種類の性格タイプ</h3>
                    <p className="text-gray-700">
                      フルテスト（42問）では、より詳細な性格タイプ診断ができます。
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="text-3xl flex-shrink-0">📈</div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">6段階の意識レベル</h3>
                    <p className="text-gray-700">
                      より正確な意識レベルの判定が可能になります。
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="text-3xl flex-shrink-0">🎁</div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">無料プレゼント</h3>
                    <p className="text-gray-700 font-semibold text-purple-600">
                      無料オンライン勉強会に参加すると、フルテスト＋2週間のAIコーチング無制限利用がプレゼントされます！
                    </p>
                  </div>
                </div>
              </div>

              <button className="w-full py-4 px-6 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-semibold rounded-lg transition-all duration-300 shadow-lg">
                無料勉強会に申し込む
              </button>
            </div>

            {/* Continue Coaching */}
            <div className="mt-8 text-center">
              <Link
                href="/free/coaching"
                className="inline-block text-blue-600 hover:text-blue-700 font-semibold"
              >
                ← AIコーチングに戻る
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
