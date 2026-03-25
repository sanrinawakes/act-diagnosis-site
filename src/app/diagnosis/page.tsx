'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthGuard from '@/components/AuthGuard';
import { consciousnessQuestions } from '@/data/consciousness-questions';
import { personalityQuestions } from '@/data/personality-questions';
import { determineLevel, determineType } from '@/data/scoring';
import { createClient } from '@/lib/supabase';
import type { CLQuestion, PersonalityQuestion } from '@/lib/types';

interface GrowthAnswers {
  selected: string[];
}

interface ImmaturityAnswers {
  selected: string | null;
}

export default function DiagnosisPage() {
  return (
    <AuthGuard>
      <DiagnosisContent />
    </AuthGuard>
  );
}

function DiagnosisContent() {
  const router = useRouter();
  const supabase = createClient();

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
    { key: 'A', text: '自分の未熟さを受け入れ行動を変えたとき。' },
    { key: 'B', text: 'まわりの反応が肯定的なものに変わったとき。' },
    { key: 'C', text: '冷静に中庸に物事を見られていると確信が持てたとき。' },
    { key: 'D', text: '他者や状況をコントロールしていたことに気づいたとき。' },
    { key: 'E', text: '他人や社会の反応に動じず、自分の価値基準で判断できたとき。' },
    { key: 'F', text: 'つい反応してしまった自分に気づいたとき。' },
    { key: 'G', text: '自分の影響力が広がったとき。' },
    { key: 'H', text: '他人を見下していたことに気づいたとき。' },
  ];

  // Immaturity question choices
  const immaturityChoices = [
    { key: 'A', text: '結果的に人間関係を悪くしてしまった時' },
    { key: 'B', text: '自分が"正しく伝えた"と思っていたことが、相手にとってはただの支配だったと気づいたとき' },
    { key: 'C', text: '私の話をまだ受け取れるレベルではない人に伝えようとしてしまったとき' },
    { key: 'D', text: '相手から誤解されてしまったとき' },
    { key: 'E', text: 'そもそも全ては完璧なのでまだまだも未熟もない' },
    { key: 'F', text: '誰かが苦しんでいるのを前に、自分には何もできないと痛感したとき' },
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

  // Render stages
  if (stage === 'copyright') {
    return <CopyrightStage onAgree={handleCopyrightAgree} />;
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
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
          <p className="text-gray-700">診断結果を保存中...</p>
        </div>
      </div>
    );
  }

  return null;
}

// Copyright Stage Component
function CopyrightStage({ onAgree }: { onAgree: () => void }) {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">ACT診断テスト</h1>
        <div className="space-y-4 mb-8">
          <p className="text-gray-700 text-lg">
            このテストは、あなたの現在の意識レベルと性格タイプを診断するものです。
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 space-y-4 max-h-96 overflow-y-auto">
            <p className="text-gray-900 font-semibold">著作権表示：</p>
            <p className="text-gray-700 text-sm leading-relaxed">
              本診断テストの内容、デザイン、システムは著作権で保護されています。このテストの結果は個人利用のみを目的としており、
              商業的な利用、無断複製、配布は禁止されています。
            </p>
            <p className="text-gray-700 text-sm leading-relaxed">
              このテストを受けることで、あなたはこの利用条件に同意したものとみなされます。
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
            著作権表示に同意し、テストを開始します
          </label>
        </div>

        <button
          onClick={onAgree}
          disabled={!agreed}
          className="w-full py-3 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
        >
          テストを開始
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
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        {/* Progress Bar */}
        <div className="mb-6">
          <ProgressBar current={questionIndex} total={totalQuestions} />
        </div>

        {/* Question Counter */}
        <div className="text-sm text-blue-600 font-semibold mb-6">
          質問 {questionIndex + 1} / {totalQuestions}
        </div>

        {/* Question Text */}
        <h2 className="text-2xl font-bold text-gray-900 mb-4">{question.text}</h2>

        {/* Supplement if exists */}
        {question.supplement && (
          <p className="text-gray-700 mb-6 italic">{question.supplement}</p>
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
              {choice.text}
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
            戻る
          </button>
          <button
            onClick={onNext}
            disabled={!canNext}
            className="flex-1 py-3 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}

// Interstitial Stage Component
function InterstitialStage({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <h2 className="text-4xl font-bold text-gray-900 mb-8 text-center">
          次は、あなたの<span className="text-blue-600">【ふだんの行動や好み】</span>について
        </h2>

        <div className="space-y-6 mb-12">
          <p className="text-gray-700 text-lg leading-relaxed">
            ここからは、あなたのふだんの行動パターンや好みについてお聞きします。
          </p>
          <p className="text-gray-600 text-base leading-relaxed">
            正解や不正解はありません。あなたの実際の傾向を素直にお答えください。
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
            <p className="text-blue-900 text-sm font-semibold">
              このセクションでは、122個の質問があります。各質問では「どちらが正しいか」ではなく、「あなたが普段どちらを選びがちか」でお答えください。
            </p>
          </div>
        </div>

        <button
          onClick={onContinue}
          className="w-full py-3 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold rounded-lg transition-all duration-300"
        >
          性格診断を開始
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
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        {/* Guidance Banner */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <p className="text-amber-900 text-sm font-semibold">
            ※「どちらが正しいか」ではなく、「普段どちらを選びがちか」で答えてください。
          </p>
        </div>

        {/* Progress Bar */}
        <div className="mb-6">
          <ProgressBar current={questionIndex} total={totalQuestions} />
        </div>

        {/* Question Counter */}
        <div className="text-sm text-blue-600 font-semibold mb-6">
          質問 {questionIndex + 1} / {totalQuestions}
        </div>

        {/* Question Text */}
        <h2 className="text-2xl font-bold text-gray-900 mb-8">{question.text}</h2>

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
              {choice.text}
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
            戻る
          </button>
          <button
            onClick={onNext}
            disabled={!canNext}
            className="flex-1 py-3 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
          >
            {questionIndex === totalQuestions - 1 ? '完了' : '次へ'}
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
}: {
  choices: Array<{ key: string; text: string }>;
  selected: string[];
  onToggle: (key: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">成長経験について</h2>
        <p className="text-gray-700 mb-8">
          以下の8つの選択肢から、あなたが最も成長を感じたものを<span className="font-semibold">2つ選んでください</span>。
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
                <span>{choice.text}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Selected count */}
        <p className="text-sm text-blue-600 mb-8 text-center">
          選択中: {selected.length} / 2
        </p>

        {/* Submit Button */}
        <button
          onClick={onSubmit}
          disabled={selected.length !== 2}
          className="w-full py-3 px-6 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
        >
          次へ進む
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
}: {
  choices: Array<{ key: string; text: string }>;
  selected: string | null;
  onSelect: (key: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white bg-opacity-80 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">未熟さへの気づき</h2>
        <p className="text-gray-700 mb-8">
          以下の6つの選択肢から、あなたが最も当てはまるものを<span className="font-semibold">1つ選んでください</span>。
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
                <span>{choice.text}</span>
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
          診断を完了
        </button>
      </div>
    </div>
  );
}
