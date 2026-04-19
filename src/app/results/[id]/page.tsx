'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import Header from '@/components/Header';
import { createClient } from '@/lib/supabase';
import { DiagnosisResult } from '@/lib/types';
import { typeNames, levelNames, axisDescriptions, typeNamesEn, levelNamesEn, axisDescriptionsEn } from '@/data/type-names';
import { useI18n } from '@/lib/i18n';

export default function ResultDetailPage() {
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const params = useParams();
  const supabase = createClient();
  const { locale, t } = useI18n();
  const resultId = params.id as string;

  // Select locale-appropriate data
  const currentTypeNames = locale === 'en' ? typeNamesEn : typeNames;
  const currentLevelNames = locale === 'en' ? levelNamesEn : levelNames;
  const currentAxisDescriptions = locale === 'en' ? axisDescriptionsEn : axisDescriptions;

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
        if (!data) throw new Error(t('resultDetail.notFound'));

        setResult(data);
      } catch (err) {
        console.error('Failed to fetch result:', err);
        setError(t('resultDetail.loadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchResult();
  }, [router, supabase, resultId]);

  if (loading) {
    return (
      <AuthGuard>
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">{t('common.loading')}</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (error || !result) {
    return (
      <AuthGuard>
        <div className="min-h-screen p-6 sm:p-8">
          <div className="max-w-4xl mx-auto">
            <div className="bg-red-50 border border-red-200 text-red-900 p-6 rounded-lg mb-6">
              {error || t('resultDetail.notFound')}
            </div>
            <Link
              href="/results"
              className="text-blue-600 hover:text-blue-700 font-semibold transition-colors"
            >
              {t('resultDetail.backToList')}
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
      <Header />
      <div className="min-h-screen p-6 sm:p-8">
        <div className="max-w-4xl mx-auto">
          {/* Header with type code and level */}
          <div className="mb-8">
            <Link
              href="/results"
              className="text-blue-600 hover:text-blue-700 font-semibold transition-colors mb-6 inline-block"
            >
              {t('resultDetail.backToList')}
            </Link>

            <div className="bg-white border border-blue-200 rounded-lg p-8 mb-8">
              <div className="flex flex-col gap-6">
                <div className="flex items-end gap-6">
                  <div>
                    <p className="text-gray-500 text-sm mb-2">{t('resultDetail.typeCode')}</p>
                    <div className="text-7xl font-bold text-transparent bg-gradient-to-r from-blue-600 via-pink-500 to-blue-500 bg-clip-text">
                      {typeCode}
                    </div>
                  </div>

                  <div>
                    <p className="text-gray-500 text-sm mb-2">{t('resultDetail.consciousnessLevel')}</p>
                    <div className="flex items-center gap-3">
                      <div className="text-5xl font-bold text-transparent bg-gradient-to-r from-blue-600 to-pink-500 bg-clip-text">
                        {result.consciousness_level}
                      </div>
                      <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-4 py-2 rounded-lg font-semibold">
                        {currentLevelNames[result.consciousness_level]}
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-2xl font-semibold text-blue-600 mb-2">
                    {currentTypeNames[typeCode] || typeCode}
                  </p>
                  <p className="text-gray-600">
                    {new Date(result.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ja-JP', {
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
            <h2 className="text-2xl font-bold text-gray-900 mb-6">{t('resultDetail.axisTitle')}</h2>

            <div className="grid gap-4 md:grid-cols-3">
              {/* Axis 1 */}
              <div className="bg-white border border-blue-200 rounded-lg p-6">
                <p className="text-blue-600 font-semibold mb-2">
                  {t('resultDetail.axis1Label')}: {currentAxisDescriptions.axis1.description}
                </p>
                <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-blue-600 to-pink-500 bg-clip-text mb-3">
                  {axis1}
                </p>
                <p className="text-gray-700">
                  {axis1 === 'S'
                    ? currentAxisDescriptions.axis1.S
                    : axis1 === 'P'
                      ? currentAxisDescriptions.axis1.P
                      : currentAxisDescriptions.axis1.M}
                </p>
                <p className="text-gray-600 text-sm mt-3">
                  {axis1 === 'S'
                    ? t('resultDetail.axis1.S')
                    : axis1 === 'P'
                      ? t('resultDetail.axis1.P')
                      : t('resultDetail.axis1.M')}
                </p>
              </div>

              {/* Axis 2 */}
              <div className="bg-white border border-blue-200 rounded-lg p-6">
                <p className="text-blue-600 font-semibold mb-2">
                  {t('resultDetail.axis2Label')}: {currentAxisDescriptions.axis2.description}
                </p>
                <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-blue-600 to-pink-500 bg-clip-text mb-3">
                  {axis2}
                </p>
                <p className="text-gray-700">
                  {axis2 === 'V'
                    ? currentAxisDescriptions.axis2.V
                    : axis2 === 'G'
                      ? currentAxisDescriptions.axis2.G
                      : currentAxisDescriptions.axis2.M}
                </p>
                <p className="text-gray-600 text-sm mt-3">
                  {axis2 === 'V'
                    ? t('resultDetail.axis2.V')
                    : axis2 === 'G'
                      ? t('resultDetail.axis2.G')
                      : t('resultDetail.axis2.M')}
                </p>
              </div>

              {/* Axis 3 */}
              <div className="bg-white border border-blue-200 rounded-lg p-6">
                <p className="text-blue-600 font-semibold mb-2">
                  {t('resultDetail.axis3Label')}: {currentAxisDescriptions.axis3.description}
                </p>
                <p className="text-3xl font-bold text-transparent bg-gradient-to-r from-blue-600 to-pink-500 bg-clip-text mb-3">
                  {axis3}
                </p>
                <p className="text-gray-700">
                  {axis3 === 'A'
                    ? currentAxisDescriptions.axis3.A
                    : axis3 === 'E'
                      ? currentAxisDescriptions.axis3.E
                      : currentAxisDescriptions.axis3.M}
                </p>
                <p className="text-gray-600 text-sm mt-3">
                  {axis3 === 'A'
                    ? t('resultDetail.axis3.A')
                    : axis3 === 'E'
                      ? t('resultDetail.axis3.E')
                      : t('resultDetail.axis3.M')}
                </p>
              </div>
            </div>
          </div>

          {/* Consciousness Level Details */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">{t('resultDetail.levelTitle')}</h2>

            <div className="bg-white border border-blue-200 rounded-lg p-6">
              <p className="text-blue-600 font-semibold mb-3 text-lg">
                {t('resultDetail.levelLabel')} {result.consciousness_level}: {currentLevelNames[result.consciousness_level]}
              </p>

              <p className="text-gray-700 leading-relaxed">
                {result.consciousness_level === 1
                  ? t('resultDetail.level1Desc')
                  : result.consciousness_level === 2
                    ? t('resultDetail.level2Desc')
                    : result.consciousness_level === 3
                      ? t('resultDetail.level3Desc')
                      : result.consciousness_level === 4
                        ? t('resultDetail.level4Desc')
                        : result.consciousness_level === 5
                          ? t('resultDetail.level5Desc')
                          : t('resultDetail.level6Desc')}
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-4 sm:flex-row">
            <Link
              href={`/coaching?code=${typeCode}-${result.consciousness_level}`}
              className="flex-1 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold py-3 px-6 rounded-lg text-center transition-all duration-200 transform hover:scale-105 shadow-lg"
            >
              {t('resultDetail.getCoaching')}
            </Link>

            <Link
              href="/diagnosis"
              className="flex-1 bg-white border border-blue-200 hover:bg-blue-50 text-blue-600 font-semibold py-3 px-6 rounded-lg text-center transition-all duration-200 transform hover:scale-105"
            >
              {t('resultDetail.retakeDiagnosis')}
            </Link>
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
