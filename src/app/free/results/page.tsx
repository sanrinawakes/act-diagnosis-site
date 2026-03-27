'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import Header from '@/components/Header';

interface DiagnosisResult {
  level: 1 | 2;
  typeCode: string;
}

export default function FreeResultsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const getUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      setEmail(user.email || null);

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
    };

    getUser();
  }, [router, supabase]);

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

            {/* Urgent CTA Section */}
            <div
              id="study-session"
              className="bg-gradient-to-r from-purple-50 to-pink-50 border-2 border-purple-300 rounded-2xl p-8 sm:p-12"
            >
              <div className="text-center mb-6">
                <span className="inline-block bg-red-500 text-white text-sm font-bold px-4 py-1 rounded-full mb-4">期間限定・無料</span>
                <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">
                  もっと深い自分を知りたくないですか？
                </h2>
                <p className="text-gray-600 mt-2">簡易版ではわからなかった、あなたの「本当のタイプ」が明らかに</p>
              </div>

              <div className="bg-white rounded-xl p-6 mb-6 border border-purple-200">
                <h3 className="font-bold text-gray-900 mb-4 text-center">簡易版とフルテストの違い</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="text-center p-3 bg-gray-50 rounded-lg">
                    <p className="text-gray-500 font-semibold">簡易版</p>
                    <p className="text-2xl font-bold text-gray-400">15問</p>
                    <p className="text-gray-500">意識レベル2段階</p>
                    <p className="text-gray-500">タイプ判定なし</p>
                    <p className="text-gray-500">AIコーチング3回/日</p>
                  </div>
                  <div className="text-center p-3 bg-purple-50 rounded-lg border-2 border-purple-300">
                    <p className="text-purple-600 font-bold">フルテスト</p>
                    <p className="text-2xl font-bold text-purple-600">120問以上</p>
                    <p className="text-purple-700 font-semibold">意識レベル6段階</p>
                    <p className="text-purple-700 font-semibold">27種類の性格タイプ</p>
                    <p className="text-purple-700 font-semibold">AIコーチング無制限</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4 mb-8">
                <div className="flex gap-3 items-start">
                  <span className="text-green-500 text-xl flex-shrink-0">✓</span>
                  <p className="text-gray-700"><span className="font-bold">フルテスト（120問以上）</span>であなたの本当の性格タイプと意識レベルを正確に判定</p>
                </div>
                <div className="flex gap-3 items-start">
                  <span className="text-green-500 text-xl flex-shrink-0">✓</span>
                  <p className="text-gray-700"><span className="font-bold">2週間のAIコーチング無制限</span>で回数を気にせず深い対話ができる</p>
                </div>
                <div className="flex gap-3 items-start">
                  <span className="text-green-500 text-xl flex-shrink-0">✓</span>
                  <p className="text-gray-700"><span className="font-bold">勉強会で意識レベルの仕組みを学べる</span>から、診断結果の理解が深まる</p>
                </div>
                <div className="flex gap-3 items-start">
                  <span className="text-green-500 text-xl flex-shrink-0">✓</span>
                  <p className="text-gray-700"><span className="font-bold">すべて無料</span>。勉強会の参加費もフルテストも0円</p>
                </div>
              </div>

              <a
                href="https://example.com/study-session"
                className="block w-full py-5 px-6 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold rounded-lg transition-all duration-300 shadow-lg text-center text-lg animate-pulse"
              >
                無料勉強会に今すぐ申し込む →
              </a>
              <p className="text-center text-sm text-gray-500 mt-3">※ 申し込みは30秒で完了します</p>
            </div>

            {/* Testimonials */}
            <div className="mt-8 space-y-4">
              <h3 className="text-xl font-bold text-gray-900 text-center mb-4">勉強会参加者の声</h3>
              <div className="bg-white rounded-xl p-5 border border-blue-200 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 bg-pink-100 rounded-full flex items-center justify-center text-pink-600 font-bold text-sm">M</div>
                  <p className="font-semibold text-gray-900 text-sm">M.K. さん（30代・女性）</p>
                </div>
                <p className="text-gray-700 text-sm leading-relaxed">「簡易版では"レベル2"だったのが、フルテストでは"レベル3・SMA型"と判明。AIコーチとの深い対話で、人間関係が劇的に改善しました！」</p>
              </div>
              <div className="bg-white rounded-xl p-5 border border-blue-200 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold text-sm">T</div>
                  <p className="font-semibold text-gray-900 text-sm">T.S. さん（40代・男性）</p>
                </div>
                <p className="text-gray-700 text-sm leading-relaxed">「フルテストで自分がPVA型だとわかって衝撃。2週間の無料期間だけでキャリアの方向性が明確になりました。」</p>
              </div>
              <div className="bg-white rounded-xl p-5 border border-blue-200 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center text-green-600 font-bold text-sm">Y</div>
                  <p className="font-semibold text-gray-900 text-sm">Y.N. さん（20代・女性）</p>
                </div>
                <p className="text-gray-700 text-sm leading-relaxed">「AIコーチングが回数無制限だから、毎日自分と向き合えて、2週間で"あ、私変わった"と実感。周りにも勧めてます！」</p>
              </div>
            </div>

            {/* Final CTA */}
            <div className="mt-8 text-center">
              <a
                href="https://example.com/study-session"
                className="inline-block py-4 px-10 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold rounded-lg transition-all duration-300 shadow-lg text-lg"
              >
                あなたも勉強会に参加する →
              </a>
            </div>

            {/* Continue Coaching */}
            <div className="mt-6 text-center">
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
