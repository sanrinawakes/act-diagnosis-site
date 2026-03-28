'use client';

import { useState, useEffect } from 'react';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

export default function SupportPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [category, setCategory] = useState('general');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const supabase = createClient();
  const { t } = useI18n();

  useEffect(() => {
    const loadUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        setUserId(user.id);
        setEmail(user.email || '');
        // Try to get display name from profile
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', user.id)
          .single();
        if (profile?.display_name) {
          setName(profile.display_name);
        }
      }
    };
    loadUser();
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim() || !subject.trim() || !message.trim()) {
      setError('すべての必須項目を入力してください。');
      return;
    }

    setSending(true);

    try {
      const response = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          category,
          subject: subject.trim(),
          message: message.trim(),
          user_id: userId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '送信に失敗しました');
      }

      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <>
        <Header />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 max-w-lg w-full text-center">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">送信完了</h2>
            <p className="text-gray-600 mb-6">
              お問い合わせいただきありがとうございます。内容を確認の上、ご連絡いたします。
            </p>
            <button
              onClick={() => {
                setSent(false);
                setSubject('');
                setMessage('');
                setCategory('general');
              }}
              className="px-6 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors font-semibold"
            >
              別の質問をする
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 sm:p-8">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">お問い合わせ</h1>
            <p className="text-gray-600 mb-6">
              ご質問・ご要望がありましたら、以下のフォームからお気軽にお問い合わせください。
            </p>

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Name */}
              <div>
                <label htmlFor="name" className="block text-sm font-semibold text-gray-700 mb-1">
                  お名前 <span className="text-red-500">*</span>
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all"
                  placeholder="山田太郎"
                  required
                />
              </div>

              {/* Email */}
              <div>
                <label htmlFor="email" className="block text-sm font-semibold text-gray-700 mb-1">
                  メールアドレス <span className="text-red-500">*</span>
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all"
                  placeholder="example@email.com"
                  required
                />
              </div>

              {/* Category */}
              <div>
                <label htmlFor="category" className="block text-sm font-semibold text-gray-700 mb-1">
                  カテゴリ
                </label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all bg-white"
                >
                  <option value="general">一般的な質問</option>
                  <option value="account">アカウントについて</option>
                  <option value="billing">お支払いについて</option>
                  <option value="bug">不具合の報告</option>
                  <option value="feature">機能リクエスト</option>
                  <option value="other">その他</option>
                </select>
              </div>

              {/* Subject */}
              <div>
                <label htmlFor="subject" className="block text-sm font-semibold text-gray-700 mb-1">
                  件名 <span className="text-red-500">*</span>
                </label>
                <input
                  id="subject"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all"
                  placeholder="お問い合わせの件名"
                  required
                />
              </div>

              {/* Message */}
              <div>
                <label htmlFor="message" className="block text-sm font-semibold text-gray-700 mb-1">
                  お問い合わせ内容 <span className="text-red-500">*</span>
                </label>
                <textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-400/50 transition-all resize-vertical"
                  placeholder="お問い合わせ内容を詳しくご記入ください"
                  required
                />
              </div>

              {/* Error */}
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={sending}
                className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white font-semibold rounded-lg transition-colors disabled:cursor-not-allowed"
              >
                {sending ? '送信中...' : '送信する'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
