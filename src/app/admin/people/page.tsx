'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AdminGuard from '@/components/AdminGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { typeNames, levelNames } from '@/data/type-names';

interface PersonEntry {
  id: string;
  name: string;
  type_code: string;
  consciousness_level: number;
  date: string;
  notes: string;
}

const ITEMS_PER_PAGE = 20;

export default function AdminPeoplePage() {
  const [people, setPeople] = useState<PersonEntry[]>([]);
  const [filteredPeople, setFilteredPeople] = useState<PersonEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    type_code: '',
    consciousness_level: 3,
    date: new Date().toISOString().split('T')[0],
    notes: '',
  });
  const supabase = createClient();

  useEffect(() => {
    fetchPeople();
  }, []);

  useEffect(() => {
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      setFilteredPeople(
        people.filter(
          (p) =>
            p.name.toLowerCase().includes(term) ||
            p.type_code.toLowerCase().includes(term) ||
            p.notes.toLowerCase().includes(term)
        )
      );
    } else {
      setFilteredPeople(people);
    }
    setCurrentPage(1);
  }, [searchTerm, people]);

  const fetchPeople = async () => {
    try {
      setLoading(true);
      const { data, error: fetchError } = await supabase
        .from('people_management')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) {
        // テーブルが存在しない場合は空の状態で表示
        if (fetchError.code === '42P01' || fetchError.message.includes('does not exist')) {
          setPeople([]);
          setFilteredPeople([]);
          setError('人材管理テーブルがまだ作成されていません。データベースにマイグレーションを適用してください。');
          return;
        }
        throw fetchError;
      }

      const entries: PersonEntry[] = (data || []).map((row: any) => ({
        id: row.id,
        name: row.name,
        type_code: row.type_code,
        consciousness_level: row.consciousness_level,
        date: row.date,
        notes: row.notes || '',
      }));

      setPeople(entries);
      setFilteredPeople(entries);
    } catch (err) {
      console.error('Failed to fetch people:', err);
      setError('人材データの取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.name.trim()) {
      setError('名前を入力してください');
      return;
    }
    if (!formData.type_code.trim() || formData.type_code.length !== 3) {
      setError('タイプコードは3文字で入力してください（例: SVA）');
      return;
    }

    try {
      if (editingId) {
        // 更新
        const { error: updateError } = await supabase
          .from('people_management')
          .update({
            name: formData.name.trim(),
            type_code: formData.type_code.toUpperCase().trim(),
            consciousness_level: formData.consciousness_level,
            date: formData.date,
            notes: formData.notes.trim(),
          })
          .eq('id', editingId);

        if (updateError) throw updateError;
        setSuccessMessage('更新しました');
      } else {
        // 新規追加
        if (people.length >= 100) {
          setError('登録上限（100名）に達しています');
          return;
        }

        const { error: insertError } = await supabase
          .from('people_management')
          .insert({
            name: formData.name.trim(),
            type_code: formData.type_code.toUpperCase().trim(),
            consciousness_level: formData.consciousness_level,
            date: formData.date,
            notes: formData.notes.trim(),
          });

        if (insertError) throw insertError;
        setSuccessMessage('追加しました');
      }

      setFormData({
        name: '',
        type_code: '',
        consciousness_level: 3,
        date: new Date().toISOString().split('T')[0],
        notes: '',
      });
      setShowAddForm(false);
      setEditingId(null);
      fetchPeople();
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      console.error('Failed to save person:', err);
      setError('保存に失敗しました');
    }
  };

  const handleEdit = (person: PersonEntry) => {
    setFormData({
      name: person.name,
      type_code: person.type_code,
      consciousness_level: person.consciousness_level,
      date: person.date,
      notes: person.notes,
    });
    setEditingId(person.id);
    setShowAddForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('この人物を削除してもよろしいですか？')) return;

    try {
      const { error: deleteError } = await supabase
        .from('people_management')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;

      setSuccessMessage('削除しました');
      fetchPeople();
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      console.error('Failed to delete person:', err);
      setError('削除に失敗しました');
    }
  };

  const handleCancelEdit = () => {
    setFormData({
      name: '',
      type_code: '',
      consciousness_level: 3,
      date: new Date().toISOString().split('T')[0],
      notes: '',
    });
    setShowAddForm(false);
    setEditingId(null);
  };

  const totalPages = Math.ceil(filteredPeople.length / ITEMS_PER_PAGE);
  const paginatedPeople = filteredPeople.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  return (
    <AdminGuard>
      <Header />
      <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-purple-950 to-slate-900">
        <div className="container mx-auto px-4 py-8">
          {/* ヘッダー */}
          <div className="mb-8 flex items-start justify-between">
            <div>
              <Link
                href="/admin"
                className="text-indigo-400 hover:text-indigo-300 text-sm mb-4 inline-block"
              >
                ← ダッシュボードに戻る
              </Link>
              <h1 className="text-4xl font-bold text-white">人材管理</h1>
              <p className="text-gray-400 mt-1">
                {people.length}/100名 登録済み
              </p>
            </div>
            {!showAddForm && (
              <button
                onClick={() => setShowAddForm(true)}
                disabled={people.length >= 100}
                className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
              >
                新規追加
              </button>
            )}
          </div>

          {/* メッセージ */}
          {successMessage && (
            <div className="mb-6 p-4 bg-green-900/50 border border-green-700 rounded-lg text-green-300">
              {successMessage}
            </div>
          )}
          {error && (
            <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-300">
              {error}
            </div>
          )}

          {/* 追加/編集フォーム */}
          {showAddForm && (
            <div className="bg-gradient-to-br from-indigo-900/30 to-purple-900/30 border border-indigo-700/50 rounded-xl p-6 mb-8">
              <h2 className="text-xl font-semibold text-white mb-4">
                {editingId ? '人物を編集' : '新規追加'}
              </h2>
              <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">名前</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="山田太郎"
                    required
                    className="w-full px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    タイプコード (3文字)
                  </label>
                  <input
                    type="text"
                    value={formData.type_code}
                    onChange={(e) =>
                      setFormData({ ...formData, type_code: e.target.value.toUpperCase().slice(0, 3) })
                    }
                    placeholder="SVA"
                    maxLength={3}
                    required
                    className="w-full px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 uppercase"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    意識レベル (1-6)
                  </label>
                  <select
                    value={formData.consciousness_level}
                    onChange={(e) =>
                      setFormData({ ...formData, consciousness_level: parseInt(e.target.value) })
                    }
                    className="w-full px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                  >
                    {[1, 2, 3, 4, 5, 6].map((level) => (
                      <option key={level} value={level}>
                        {level} - {levelNames[level]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">日付</label>
                  <input
                    type="date"
                    value={formData.date}
                    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                    required
                    className="w-full px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-300 mb-1">メモ</label>
                  <input
                    type="text"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    placeholder="自由記入"
                    className="w-full px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="sm:col-span-2 lg:col-span-3 flex gap-3">
                  <button
                    type="submit"
                    className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition-colors"
                  >
                    {editingId ? '更新' : '追加'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold rounded-lg transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* 検索 */}
          <div className="mb-6">
            <input
              type="text"
              placeholder="名前・タイプ・メモで検索..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-4 py-2 bg-indigo-950/50 border border-indigo-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* テーブル */}
          {loading ? (
            <div className="flex justify-center items-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-400"></div>
            </div>
          ) : (
            <>
              <div className="bg-indigo-950/30 border border-indigo-700/50 rounded-lg overflow-hidden shadow-xl">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-indigo-950/50 border-b border-indigo-700/50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          名前
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          タイプ
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          意識レベル
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          日付
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          メモ
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-semibold text-indigo-300 uppercase">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-700/30">
                      {paginatedPeople.length > 0 ? (
                        paginatedPeople.map((person) => (
                          <tr key={person.id} className="hover:bg-indigo-900/20 transition-colors">
                            <td className="px-6 py-4 text-sm text-white font-medium">
                              {person.name}
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-lg font-bold text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text">
                                {person.type_code}
                              </span>
                              <p className="text-xs text-gray-400">
                                {typeNames[person.type_code] || ''}
                              </p>
                            </td>
                            <td className="px-6 py-4">
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-900/50 text-indigo-300">
                                Lv.{person.consciousness_level} {levelNames[person.consciousness_level]}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-400">
                              {person.date}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-400 max-w-[200px] truncate">
                              {person.notes || '-'}
                            </td>
                            <td className="px-6 py-4 text-sm flex gap-2">
                              <button
                                onClick={() => handleEdit(person)}
                                className="px-2 py-1 rounded bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 text-xs font-medium transition-colors"
                              >
                                編集
                              </button>
                              <button
                                onClick={() => handleDelete(person.id)}
                                className="px-2 py-1 rounded bg-red-900/50 hover:bg-red-900 text-red-300 text-xs font-medium transition-colors"
                              >
                                削除
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="px-6 py-8 text-center text-gray-400">
                            {people.length === 0 ? 'まだ人物が登録されていません' : '検索結果がありません'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ページネーション */}
              {totalPages > 1 && (
                <div className="mt-6 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="px-4 py-2 bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    前へ
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`px-3 py-2 rounded transition-colors ${
                        currentPage === page
                          ? 'bg-indigo-600 text-white'
                          : 'bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300'
                      }`}
                    >
                      {page}
                    </button>
                  ))}
                  <button
                    onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="px-4 py-2 bg-indigo-900/50 hover:bg-indigo-900 text-indigo-300 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    次へ
                  </button>
                </div>
              )}

              <div className="mt-4 text-center text-gray-400 text-sm">
                {filteredPeople.length > 0 && (
                  <>
                    {(currentPage - 1) * ITEMS_PER_PAGE + 1}～
                    {Math.min(currentPage * ITEMS_PER_PAGE, filteredPeople.length)}件を表示
                    (合計: {filteredPeople.length}件)
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AdminGuard>
  );
}
