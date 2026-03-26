'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import AuthGuard from '@/components/AuthGuard';
import { consciousnessQuestions } from '@/data/consciousness-questions';
import { personalityQuestions } from '@/data/personality-questions';
import { determineLevel, determineType } from '@/data/scoring';
import { createClient } from '@/lib/supabase';
import { useSubscriptionGuard } from '@/hooks/useSubscriptionGuard';
import type { CLQuestion, PersonalityQuestion } from '@/lib/types';

interface GrowthAnswers {
  selected: string[];
}

interface ImmaturityAnswers {
  selected: string | null;
}

export default function DiagnosisPage() {
  const { loading, allowed } = useSubscriptionGuard();

  if (loading) {
    return (
      <AuthGuard>
        <div className="min-h-screen flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
            <p className="text-gray-700">Loading...</p>
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (!allowed) {
    return null;
  }

  return (
    <AuthGuard>
      <DiagnosisContent />
    </AuthGuard>
  );
}

function DiagnosisContent() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useI18n();

  // Stage: 'copyright' | 'consciousness' | 'interstitial' | 'personality' | 'growth' | 'immaturity' | 'loading'
  const [stage, setStage] = useState<string>('copyright');
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState<number>(0);
  const [consciousnessAnswers, setConsciousnessAnswers] = useState<number[]>(
    Array(consciousnessQuestions.length).fill(-999)
  );
  const [personalityAnswers, setPersonalityAnswers] = useState<Record<string, number>>(
    Object.fromEntries(personalityQuestions.map((q) => [q.id, -999]))
  );
  const [personalityScores, setPersonalityScores] = useState<Record<string, number>>({});
  const [growthAnswers, setGrowthAnswers] = useState<GrowthAnswers>({ selected: [] });
  const [immaturityAnswers, setImmaturityAnswers] = useState<ImmaturityAnswers>({
    selected: null,
  });
  const [consciousnessLevel, setConsciousnessLevel] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const allConsciousnessAnswered =
    consciousnessAnswers.every((answer) => answer !== -999);
  const allPersonalityAnswered =
    personalityQuestions.every((q) => personalityAnswers[q.id] !== -999);

  // Growth question choices
  const growthChoices = [
    { key: 'A', text: '自分の未熟さを受け入れ行動を変えたとき。', text_en: 'When I accepted my immaturity and changed my actions.' },
    { key: 'B', text: 'まわりの反応が肯定的なものに変わったとき。', text_en: 'When those around me started responding more positively.' },
    { key: 'C', text: '冷静に中庸に物事を見られていると確信が持てたとき。', text_en: 'When I became confident in viewing things calmly and with balance.' },
    { key: 'D', text: '他者や状況をコントロールしていたことに気づいたとき。', text_en: 'When I realized I had been trying to control others or situations.' },
    { key: 'E', text: '他人や社会の反応に動じず、自分の価値基準で判断できたとき。', text_en: 'When I could judge things by my own values without being swayed by others\' reactions.' },
    { key: 'F', text: 'つい反応してしまった自分に気づいたとき。', text_en: 'When I realized I had been reacting impulsively.' },
    { key: 'G', text: '自分の影響力が広がったとき。', text_en: 'When my influence expanded.' },
    { key: 'H', text: '他人を見下していたことに気づいたとき。', text_en: 'When I realized I had been looking down on others.' },
  ];

  // Immaturity question choices
  const immaturityChoices = [
    { key: 'A', text: '結果的に人間関係を悪くしてしまった時', text_en: 'When I ended up damaging my relationships' },
    { key: 'B', text: '自分が"正しく伝えた"と思っていたことが、相手にとってはただの支配だったと気づいたとき', text_en: 'When I realized that what I thought was "communicating clearly" was actually controlling to the other person' },
    { key: 'C', text: '私の話をまだ受け取れるレベルではない人に伝えようとしてしまったとき', text_en: 'When I tried to share with someone who wasn\'t ready to receive it' },
    { key: 'D', text: '相手から誤解されてしまったとき', text_en: 'When I was misunderstood by the other person' },
    { key: 'E', text: 'そもそも全ては完璧なのでまだまだも未熟もない', text_en: 'Everything is already perfect, so there\'s no such thing as incompleteness or immaturity' },
    { key: 'F', text: '誰かが苦しんでいるのを前に、自分には何もできないと痛感したとき', text_en: 'When facing someone\'s suffering, I painfully realized I could do nothing to help' },
  ];

  // Handle copyright agreement
  const handleCopyrightAgree = () => {
    setStage('consciousness');
  };

  // Handle consciousness question answer - store choice INDEX (not score)
  const handleConsciousnessAnswer = (choiceIndex: number) => {
    const newAnswers = [...consciousnessAnswers];
    newAnswers[currentQuestionIndex] = choiceIndex;
    setConsciousnessAnswers(newAnswers);
  };

  // Handle consciousness next/previous
  const handleConsciousnessNext = () => {
    if (currentQuestionIndex < consciousnessQuestions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      // All consciousness questions answered
      const level = determineLevel(consciousnessAnswers, consciousnessQuestions);
      setConsciousnessLevel(level);
      setStage('interstitial');
    }
  };

  const handleConsciousnessPrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
    }
  };

  // Handle personality question answer
  const handlePersonalityAnswer = (questionId: number, choiceIndex: number) => {
    const question = personalityQuestions.find((q) => q.id === questionId);
    if (!question) return;

    const newScores = { ...personalityScores };

    // If previously answered, subtract old scores first
    const previousChoiceIndex = personalityAnswers[questionId];
    if (previousChoiceIndex !== -999 && previousChoiceIndex >= 0) {
      const prevChoice = question.choices[previousChoiceIndex];
      if (prevChoice) {
        Object.entries(prevChoice.scores).forEach(([key, value]) => {
          newScores[key] = (newScores[key] || 0) - value;
        });
      }
    }

    // Add scores from new choice
    const choice = question.choices[choiceIndex];
    Object.entries(choice.scores).forEach(([key, value]) => {
      newScores[key] = (newScores[key] || 0) + value;
    });

    setPersonalityScores(newScores);
    const newAnswers = { ...personalityAnswers };
    newAnswers[questionId] = choiceIndex;
    setPersonalityAnswers(newAnswers);
  };

  // Handle personality navigation
  const handlePersonalityNext = () => {
    if (currentQuestionIndex < personalityQuestions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      // All personality questions answered, check if need growth questions
      if (consciousnessLevel !== null && consciousnessLevel >= 4) {
        setCurrentQuestionIndex(0);
        setStage('growth');
      } else {
        // Save results without growth questions
        handleFinalSubmit(null, null);
      }
    }
  };

  const handlePersonalityPrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
    }
  };

  // Handle growth question selection
  const handleGrowthToggle = (key: string) => {
    const newSelected = [...growthAnswers.selected];
    if (newSelected.includes(key)) {
      newSelected.splice(newSelected.indexOf(key), 1);
    } else if (newSelected.length < 2) {
      newSelected.push(key);
    }
    setGrowthAnswers({ selected: newSelected });
  };

  // Handle growth submission
  const handleGrowthSubmit = () => {
    if (growthAnswers.selected.length === 2) {
      const validChoices = ['A', 'D', 'F', 'H'];
      const selectedValidCount = growthAnswers.selected.filter((key) =>
        validChoices.includes(key)
      ).length;
      if (selectedValidCount === 2) {
        // Both choices are from the valid set → proceed to immaturity question
        setStage('immaturity');
      } else {
        // Not both from valid set → cap at level 3
        if (consciousnessLevel !== null) {
          setConsciousnessLevel(Math.min(consciousnessLevel, 3));
        }
        handleFinalSubmit(growthAnswers.selected, 'SKIPPED');
      }
    }
  };

  // Handle immaturity selection
  const handleImmaturitySubmit = () => {
    if (immaturityAnswers.selected) {
      handleFinalSubmit(growthAnswers.selected, immaturityAnswers.selected);
    }
  };

  // Final submission to save results
  const handleFinalSubmit = async (
    growthSelected: string[] | null,
    immaturitySelected: string | null
  ) => {
    setLoading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Determine final consciousness level based on growth/immaturity answers
      let finalLevel = consciousnessLevel || 3;
      if (immaturitySelected && immaturitySelected !== 'B') {
        finalLevel = Math.min(finalLevel, 3);
      }

      // Determine personality type
      const typeCode = determineType(personalityScores);

      // Save to Supabase
      const { data, error } = await supabase
        .from('diagnosis_results')
        .insert([
          {
            user_id: user.id,
            type_code: typeCode,
            consciousness_level: finalLevel,
            subtype: null,
            scores_json: personalityScores,
            answers_json: {
              consciousness: consciousnessAnswers,
              personality: personalityAnswers,
              growth: growthSelected,
              immaturity: immaturitySelected,
            },
          },
        ])
        .select()
        .single();

      if (error) throw error;

      // Redirect to results page
      router.push(`/results/${data.id}`);
    } catch (error) {
      console.error('Error saving diagnosis:', error);
      setLoading(false);
    }
  };

  const handleCancel = () => {
    router.push('/');
  };

  // Render stages
  if (stage === 'copyright') {
    return <CopyrightStage onAgree={handleCopyrightAgree} onCancel={handleCancel} />;
  }

  if (stage === 'consciousness') {
    const question = consciousnessQuestions[currentQuestionIndex];
    return (
      <ConsciousnessStage
        question={question}
        questionIndex={currentQuestionIndex}
        totalQuestions={consciousnessQuestions.length}
        selectedChoiceIndex={
          consciousnessAnswers[currentQuestionIndex] === -999
            ? -1
            : consciousnessQuestions[currentQuestionIndex].choices.findIndex(
                (c) => c.score === consciousnessAnswers[currentQuestionIndex]
              )
        }
        onAnswer={handleConsciousnessAnswer}
        onNext={handleConsciousnessNext}
        onPrevious={handleConsciousnessPrevious}
        canNext={consciousnessAnswers[currentQuestionIndex] !== -999}
        canPrevious={currentQuestionIndex > 0}
        onCancel={handleCancel}
      />
    );
  }

  if (stage === 'interstitial') {
    return (
      <InterstitialStage
        onContinue={() => {
          setCurrentQuestionIndex(0);
          setStage('personality');
        }}
        onCancel={handleCancel}
      />
    );
  }

  if (stage === 'personality') {
    const question = personalityQuestions[currentQuestionIndex];
    return (
      <PersonalityStage
        question={question}
        questionIndex={currentQuestionIndex}
        totalQuestions={personalityQuestions.length}
        selectedChoiceIndex={
          personalityAnswers[question.id] === -999
            ? -1
            : personalityAnswers[question.id]
        }
        onAnswer={(choiceIndex) => handlePersonalityAnswer(question.id, choiceIndex)}
        onNext={handlePersonalityNext}
        onPrevious={handlePersonalityPrevious}
        canNext={personalityAnswers[question.id] !== -999}
        canPrevious={currentQuestionIndex > 0}
        onCancel={handleCancel}
      />
    );
  }

  if (stage === 'growth') {
    return (
      <GrowthStage
        choices={growthChoices}
        selected={growthAnswers.selected}
        onToggle={handleGrowthToggle}
        onSubmit={handleGrowthSubmit}
        onCancel={handleCancel}
      />
    );
  }

  if (stage === 'immaturity') {
    return (
      <ImmaturityStage
        choices={immaturityChoices}
        selected={immaturityAnswers.selected}
        onSelect={(key) => setImmaturityAnswers({ selected: key })}
        onSubmit={handleImmaturitySubmit}
        onCancel={handleCancel}
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
          <p className="text-gray-700">{t('diagnosis.saving')}</p>
        </div>
      </div>
    );
  }

  return null;
}

// Copyright Stage Component
function CopyrightStage({ onAgree, onCancel }: { onAgree: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <div className="flex justify-between items-start mb-6">
          <h1 className="text-3xl font-bold text-gray-900">{t('diagnosis.title')}</h1>
          <button onClick={onCancel} className="text-gray-400 hover:text-red-500 transition-colors text-sm flex items-center gap-1">
            <span>✕</span><span>{t('diagnosis.cancel')}</span>
          </button>
        </div>
        <div className="space-y-4 mb-8">
          <p className="text-gray-700 text-lg">
            {t('diagnosis.description')}
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 space-y-4 max-h-96 overflow-y-auto">
            <p className="text-gray-900 font-semibold">{t('diagnosis.copyright.title')}</p>
            <p className="text-gray-700 text-sm leading-relaxed">
              {t('diagnosis.copyright.text1')}
            </p>
            <p className="text-gray-700 text-sm leading-relaxed">
              {t('diagnosis.copyright.text2')}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-4 mb-8">
          <input
            type="checkbox"
            id="copyright-agree"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 w-5 h-5 cursor-pointer accent-blue-500"
          />
          <label htmlFor="copyright-agree" className="text-gray-700 cursor-pointer flex-1">
            {t('diagnosis.copyright.agree')}
          </label>
        </div>

        <button
          onClick={onAgree}
          disabled={!agreed}
          className="w-full py-3 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
        >
          {t('diagnosis.startTest')}
        </button>
      </div>
    </div>
  );
}

// Progress Bar Component
function ProgressBar({ current, total }: { current: number; total: number }) {
  const percentage = ((current + 1) / total) * 100;
  return (
    <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-blue-400 to-pink-500 rounded-full transition-all duration-500 ease-out"
        style={{ width: `${percentage}%` }}
      >
        <div className="h-full bg-white opacity-20 animate-pulse"></div>
      </div>
    </div>
  );
}

// Consciousness Stage Component
function ConsciousnessStage({
  question,
  questionIndex,
  totalQuestions,
  selectedChoiceIndex,
  onAnswer,
  onNext,
  onPrevious,
  canNext,
  canPrevious,
  onCancel,
}: {
  question: CLQuestion;
  questionIndex: number;
  totalQuestions: number;
  selectedChoiceIndex: number;
  onAnswer: (choiceIndex: number) => void;
  onNext: () => void;
  onPrevious: () => void;
  canNext: boolean;
  canPrevious: boolean;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();

  const getLocalizedText = (item: { text: string; text_en?: string }) => {
    return locale === 'en' && item.text_en ? item.text_en : item.text;
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        {/* Cancel Button */}
        <div className="flex justify-end mb-4">
          <button onClick={onCancel} className="text-gray-400 hover:text-red-500 transition-colors text-sm flex items-center gap-1">
            <span>✕</span><span>{t('diagnosis.cancel')}</span>
          </button>
        </div>

        {/* Progress Bar */}
        <div className="mb-6">
          <ProgressBar current={questionIndex} total={totalQuestions} />
        </div>

        {/* Question Counter */}
        <div className="text-sm text-blue-600 font-semibold mb-6">
          {t('diagnosis.question')} {questionIndex + 1} / {totalQuestions}
        </div>

        {/* Question Text */}
        <h2 className="text-2xl font-bold text-gray-900 mb-4">{getLocalizedText(question)}</h2>

        {/* Supplement if exists */}
        {question.supplement && (
          <p className="text-gray-700 mb-6 italic">
            {locale === 'en' && question.supplement_en ? question.supplement_en : question.supplement}
          </p>
        )}

        {/* Choices */}
        <div className="space-y-3 mb-8">
          {question.choices.map((choice, index) => (
            <button
              key={index}
              onClick={() => onAnswer(index)}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all duration-300 ${
                selectedChoiceIndex === index
                  ? 'border-blue-400 bg-blue-50 text-gray-900'
                  : 'border-blue-200 bg-white text-gray-700 hover:bg-blue-50'
              }`}
            >
              {getLocalizedText(choice)}
            </button>
          ))}
        </div>

        {/* Navigation Buttons */}
        <div className="flex gap-4">
          <button
            onClick={onPrevious}
            disabled={!canPrevious}
            className="flex-1 py-3 px-4 bg-gray-100 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed text-gray-600 font-semibold rounded-lg transition-all duration-300"
          >
            {t('diagnosis.back')}
          </button>
          <button
            onClick={onNext}
            disabled={!canNext}
            className="flex-1 py-3 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
          >
            {t('diagnosis.next')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Interstitial Stage Component
function InterstitialStage({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  const { t } = useI18n();

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <div className="flex justify-end mb-4">
          <button onClick={onCancel} className="text-gray-400 hover:text-red-500 transition-colors text-sm flex items-center gap-1">
            <span>✕</span><span>{t('diagnosis.cancel')}</span>
          </button>
        </div>
        <h2 className="text-4xl font-bold text-gray-900 mb-8 text-center">
          {t('diagnosis.interstitial.title')}<span className="text-blue-600">【{t('diagnosis.interstitial.highlight')}】</span>{t('diagnosis.interstitial.about')}
        </h2>

        <div className="space-y-6 mb-12">
          <p className="text-gray-700 text-lg leading-relaxed">
            {t('diagnosis.interstitial.desc1')}
          </p>
          <p className="text-gray-600 text-base leading-relaxed">
            {t('diagnosis.interstitial.desc2')}
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
            <p className="text-blue-900 text-sm font-semibold">
              {t('diagnosis.interstitial.note')}
            </p>
          </div>
        </div>

        <button
          onClick={onContinue}
          className="w-full py-3 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold rounded-lg transition-all duration-300"
        >
          {t('diagnosis.interstitial.start')}
        </button>
      </div>
    </div>
  );
}

// Personality Stage Component
function PersonalityStage({
  question,
  questionIndex,
  totalQuestions,
  selectedChoiceIndex,
  onAnswer,
  onNext,
  onPrevious,
  canNext,
  canPrevious,
  onCancel,
}: {
  question: PersonalityQuestion;
  questionIndex: number;
  totalQuestions: number;
  selectedChoiceIndex: number;
  onAnswer: (choiceIndex: number) => void;
  onNext: () => void;
  onPrevious: () => void;
  canNext: boolean;
  canPrevious: boolean;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();

  const getLocalizedText = (item: { text: string; text_en?: string }) => {
    return locale === 'en' && item.text_en ? item.text_en : item.text;
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        {/* Cancel Button */}
        <div className="flex justify-end mb-4">
          <button onClick={onCancel} className="text-gray-400 hover:text-red-500 transition-colors text-sm flex items-center gap-1">
            <span>✕</span><span>{t('diagnosis.cancel')}</span>
          </button>
        </div>

        {/* Guidance Banner */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <p className="text-amber-900 text-sm font-semibold">
            {t('diagnosis.personality.guidance')}
          </p>
        </div>

        {/* Progress Bar */}
        <div className="mb-6">
          <ProgressBar current={questionIndex} total={totalQuestions} />
        </div>

        {/* Question Counter */}
        <div className="text-sm text-blue-600 font-semibold mb-6">
          {t('diagnosis.question')} {questionIndex + 1} / {totalQuestions}
        </div>

        {/* Question Text */}
        <h2 className="text-2xl font-bold text-gray-900 mb-8">{getLocalizedText(question)}</h2>

        {/* Choices */}
        <div className="space-y-3 mb-8">
          {question.choices.map((choice, index) => (
            <button
              key={index}
              onClick={() => onAnswer(index)}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all duration-300 ${
                selectedChoiceIndex === index
                  ? 'border-blue-400 bg-blue-50 text-gray-900'
                  : 'border-blue-200 bg-white text-gray-700 hover:bg-blue-50'
              }`}
            >
              {getLocalizedText(choice)}
            </button>
          ))}
        </div>

        {/* Navigation Buttons */}
        <div className="flex gap-4">
          <button
            onClick={onPrevious}
            disabled={!canPrevious}
            className="flex-1 py-3 px-4 bg-gray-100 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed text-gray-600 font-semibold rounded-lg transition-all duration-300"
          >
            {t('diagnosis.back')}
          </button>
          <button
            onClick={onNext}
            disabled={!canNext}
            className="flex-1 py-3 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
          >
            {questionIndex === totalQuestions - 1 ? t('diagnosis.complete') : t('diagnosis.next')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Growth Stage Component
function GrowthStage({
  choices,
  selected,
  onToggle,
  onSubmit,
  onCancel,
}: {
  choices: Array<{ key: string; text: string; text_en?: string }>;
  selected: string[];
  onToggle: (key: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();

  const getLocalizedText = (item: { text: string; text_en?: string }) => {
    return locale === 'en' && item.text_en ? item.text_en : item.text;
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-2xl font-bold text-gray-900">{t('diagnosis.growth.title')}</h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-red-500 transition-colors text-sm flex items-center gap-1">
            <span>✕</span><span>{t('diagnosis.cancel')}</span>
          </button>
        </div>
        <p className="text-gray-700 mb-8">
          {t('diagnosis.growth.desc')}<span className="font-semibold">{t('diagnosis.growth.count')}</span>。
        </p>

        {/* Choices */}
        <div className="space-y-3 mb-8">
          {choices.map((choice) => (
            <button
              key={choice.key}
              onClick={() => onToggle(choice.key)}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all duration-300 ${
                selected.includes(choice.key)
                  ? 'border-blue-400 bg-blue-50 text-gray-900'
                  : 'border-blue-200 bg-white text-gray-700 hover:bg-blue-50'
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`w-6 h-6 rounded border-2 flex-shrink-0 mt-0.5 flex items-center justify-center ${
                    selected.includes(choice.key)
                      ? 'border-blue-400 bg-blue-500'
                      : 'border-blue-200'
                  }`}
                >
                  {selected.includes(choice.key) && <span className="text-white font-bold">✓</span>}
                </div>
                <span>{getLocalizedText(choice)}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Selected count */}
        <p className="text-sm text-blue-600 mb-8 text-center">
          {t('diagnosis.growth.selected')}: {selected.length} / 2
        </p>

        {/* Submit Button */}
        <button
          onClick={onSubmit}
          disabled={selected.length !== 2}
          className="w-full py-3 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
        >
          {t('diagnosis.growth.submit')}
        </button>
      </div>
    </div>
  );
}

// Immaturity Stage Component
function ImmaturityStage({
  choices,
  selected,
  onSelect,
  onSubmit,
  onCancel,
}: {
  choices: Array<{ key: string; text: string; text_en?: string }>;
  selected: string | null;
  onSelect: (key: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();

  const getLocalizedText = (item: { text: string; text_en?: string }) => {
    return locale === 'en' && item.text_en ? item.text_en : item.text;
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-2xl font-bold text-gray-900">{t('diagnosis.immaturity.title')}</h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-red-500 transition-colors text-sm flex items-center gap-1">
            <span>✕</span><span>{t('diagnosis.cancel')}</span>
          </button>
        </div>
        <p className="text-gray-700 mb-8">
          {t('diagnosis.immaturity.desc')}<span className="font-semibold">{t('diagnosis.immaturity.count')}</span>。
        </p>

        {/* Choices */}
        <div className="space-y-3 mb-8">
          {choices.map((choice) => (
            <button
              key={choice.key}
              onClick={() => onSelect(choice.key)}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all duration-300 ${
                selected === choice.key
                  ? 'border-blue-400 bg-blue-50 text-gray-900'
                  : 'border-blue-200 bg-white text-gray-700 hover:bg-blue-50'
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`w-6 h-6 rounded-full border-2 flex-shrink-0 mt-0.5 flex items-center justify-center ${
                    selected === choice.key
                      ? 'border-blue-400 bg-blue-500'
                      : 'border-blue-200'
                  }`}
                >
                  {selected === choice.key && <span className="text-white font-bold text-sm">✓</span>}
                </div>
                <span>{getLocalizedText(choice)}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Submit Button */}
        <button
          onClick={onSubmit}
          disabled={!selected}
          className="w-full py-3 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
        >
          {t('diagnosis.immaturity.submit')}
        </button>
      </div>
    </div>
  );
}
