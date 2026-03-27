'use client';

import Header from '@/components/Header';
import Link from 'next/link';

export default function FreeLandingPage() {
  return (
    <main className="min-h-screen">
      <Header />

      {/* Hero Section */}
      <div className="relative overflow-hidden">
        {/* Background decorative elements */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob"></div>
          <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-pink-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000"></div>
          <div className="absolute top-1/2 left-1/2 w-80 h-80 bg-cyan-300 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-4000"></div>
        </div>

        {/* Content */}
        <div className="relative z-10 px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="max-w-2xl mx-auto text-center">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 mb-6 drop-shadow-lg">
              あなたの意識タイプを無料で診断
            </h1>
            <p className="text-lg sm:text-xl text-gray-600 mb-4 drop-shadow">
              会員登録で利用可能
            </p>
            <p className="text-base sm:text-lg text-gray-600 mb-12 drop-shadow">
              15問の簡易テスト + AIコーチング3回/日
            </p>

            {/* Start Button */}
            <Link
              href="/free/diagnosis"
              className="inline-block py-4 px-8 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold rounded-lg transition-all duration-300 shadow-lg"
            >
              無料診断を始める
            </Link>

            {/* Features */}
            <div className="mt-16 grid md:grid-cols-3 gap-6 max-w-3xl mx-auto">
              <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                <div className="text-3xl mb-3">✓</div>
                <h3 className="font-semibold text-gray-900 mb-2">会員登録で利用可能</h3>
                <p className="text-sm text-gray-600">ログイン後に診断を開始</p>
              </div>
              <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                <div className="text-3xl mb-3">⚡</div>
                <h3 className="font-semibold text-gray-900 mb-2">15問で完結</h3>
                <p className="text-sm text-gray-600">5分で意識レベルを診断</p>
              </div>
              <div className="bg-white/70 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                <div className="text-3xl mb-3">🤖</div>
                <h3 className="font-semibold text-gray-900 mb-2">AIコーチング</h3>
                <p className="text-sm text-gray-600">毎日3回まで無料で相談可能</p>
              </div>
            </div>

            {/* Full Test Comparison */}
            <div className="mt-16 bg-gradient-to-r from-purple-50 to-pink-50 backdrop-blur rounded-xl p-8 border-2 border-purple-200 max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">簡易版 vs フルテスト</h2>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-white rounded-lg p-4 border border-gray-200">
                  <p className="text-sm font-semibold text-gray-500 mb-2">簡易版（今すぐ）</p>
                  <p className="text-2xl font-bold text-gray-900">15問</p>
                  <p className="text-sm text-gray-600 mt-1">意識レベル2段階</p>
                </div>
                <div className="bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg p-4 text-white">
                  <p className="text-sm font-semibold text-purple-100 mb-2">フルテスト</p>
                  <p className="text-2xl font-bold">120問以上</p>
                  <p className="text-sm text-purple-100 mt-1">27タイプ × 6段階</p>
                </div>
              </div>
              <p className="text-gray-700 mb-3">フルテスト（120問以上）では、27種類の性格タイプと6段階の意識レベルを正確に判定。あなただけの詳細な分析レポートが手に入ります。</p>
              <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 mb-4">
                <p className="font-bold text-yellow-800">🎁 今だけ特典</p>
                <p className="text-yellow-800">無料オンライン勉強会に参加するだけで、フルテスト＋2週間のAIコーチング無制限利用を丸ごとプレゼント！</p>
              </div>
              <a
                href="https://example.com/study-session"
                className="block w-full py-4 px-6 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold rounded-lg transition-all duration-300 shadow-lg text-center text-lg"
              >
                無料勉強会に今すぐ申し込む →
              </a>
            </div>

            {/* Testimonials */}
            <div className="mt-16 max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-8 text-center">勉強会参加者のお喜びの声</h2>
              <div className="space-y-4">
                <div className="bg-white/80 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-pink-100 rounded-full flex items-center justify-center text-pink-600 font-bold">M</div>
                    <div>
                      <p className="font-semibold text-gray-900">M.K. さん（30代・女性）</p>
                      <p className="text-xs text-gray-500">フルテスト体験者</p>
                    </div>
                  </div>
                  <p className="text-gray-700 leading-relaxed">「簡易版では"レベル2"だったのが、フルテストでは"レベル3・SMA型"と判明。AIコーチとの深い対話で、自分が無意識にやっていた"変装パターン"に気づけて、人間関係が劇的に改善しました。勉強会は参加して本当によかったです！」</p>
                </div>
                <div className="bg-white/80 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold">T</div>
                    <div>
                      <p className="font-semibold text-gray-900">T.S. さん（40代・男性）</p>
                      <p className="text-xs text-gray-500">フルテスト体験者</p>
                    </div>
                  </div>
                  <p className="text-gray-700 leading-relaxed">「正直、最初は"無料だし試しに"くらいの気持ちでした。でもフルテストを受けたら、自分がPVA型だとわかって衝撃。AIコーチが僕の行動パターンを的確に分析してくれて、キャリアの方向性が明確になりました。2週間の無料期間だけでここまで変わるとは思いませんでした。」</p>
                </div>
                <div className="bg-white/80 backdrop-blur rounded-xl p-6 border border-blue-200/50">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-green-600 font-bold">Y</div>
                    <div>
                      <p className="font-semibold text-gray-900">Y.N. さん（20代・女性）</p>
                      <p className="text-xs text-gray-500">フルテスト体験者</p>
                    </div>
                  </div>
                  <p className="text-gray-700 leading-relaxed">「勉強会で意識レベルの仕組みを学んでから、フルテストを受けたら理解が深まった。AIコーチングも回数無制限だから、毎日少しずつ自分と向き合えて、2週間で"あ、私って変わった"と実感できました。周りにも勧めてます！」</p>
                </div>
              </div>
              <div className="mt-8 text-center">
                <a
                  href="https://example.com/study-session"
                  className="inline-block py-4 px-10 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold rounded-lg transition-all duration-300 shadow-lg text-lg"
                >
                  あなたも勉強会に参加する →
                </a>
              </div>
            </div>

            {/* Study Session Links */}
            <div className="mt-12 flex items-center gap-4 justify-center">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent to-blue-200"></div>
              <span className="text-gray-600 text-sm">その他</span>
              <div className="h-px flex-1 bg-gradient-to-l from-transparent to-blue-200"></div>
            </div>

            <div className="mt-8">
              <p className="text-gray-600 mb-4">勉強会に参加してさらに詳しく学ぶ</p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <a
                  href="https://example.com/study-session"
                  className="px-8 py-3 bg-white hover:bg-gray-100 text-blue-500 font-semibold rounded-lg transition-colors duration-200 border border-blue-200"
                >
                  無料勉強会
                </a>
                <a
                  href="https://example.com/resources"
                  className="px-8 py-3 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors duration-200"
                >
                  学習リソース
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
