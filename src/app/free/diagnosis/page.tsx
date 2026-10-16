'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { consciousnessQuestions } from '@/data/consciousness-questions';

// Use only first 15 consciousness questions for free version
const freeQuestions = consciousnessQuestions.slice(0, 15);

interface DiagnosisResult {
  level: 1 | 2;
  typeCode: string;
}

export default function FreeDiagnosisPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState<string | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<number[]>(Array(freeQuestions.length).fill(-1));
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const savedResultRef = useRef<DiagnosisResult | null>(null);

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
      setInitialized(true);
    };

    getUser();
  }, [router, supabase]);

  const handleAnswer = (choiceIndex: number) => {
    if (submittingRef.current) return;
    savedResultRef.current = null;
    setSaveError(null);
    setAnswers((previous) => {
      const next = [...previous];
      next[currentQuestionIndex] = choiceIndex;
      return next;
    });
  };

  const handleNext = async () => {
    if (submittingRef.current || answers[currentQuestionIndex] < 0) return;
    if (currentQuestionIndex < freeQuestions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      // All questions answered - save results
      await handleSubmit();
    }
  };

  const handlePrevious = () => {
    if (!submittingRef.current && currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
    }
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    const scores = freeQuestions.map((question, index) => question.choices[answers[index]]?.score);
    if (scores.some((score) => score === undefined)) {
      setSaveError('すべての質問に回答してから、完了してください。');
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    setSaveError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      // Calculate consciousness level
      // Count answers with score -2: if >= 3, level = 1, else level = 2
      const lowScoreCount = scores.filter((score) => score === -2).length;
      const level: DiagnosisResult['level'] = lowScoreCount >= 3 ? 1 : 2;

      // For free version, use fixed type code "MMM" (center equilibrium)
      const typeCode = 'MMM';

      const result: DiagnosisResult = {
        level,
        typeCode,
      };

      // Retry displaying a confirmed result without submitting it again.
      if (!savedResultRef.current) {
        const response = await fetch('/api/free/diagnosis', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: email || '',
            level: level,
            typeCode: typeCode,
            answers: scores,
          }),
          signal: controller.signal,
        });
        if (!response.ok || (await response.json()).success !== true) {
          throw new Error('Diagnosis save was not confirmed');
        }
        savedResultRef.current = result;
      }

      localStorage.setItem('free_diagnosis_result', JSON.stringify(savedResultRef.current));
      router.push('/free/results');
    } catch (error) {
      console.error('Error saving diagnosis:', error);
      setSaveError(savedResultRef.current
        ? '診断結果は保存されましたが、ブラウザに表示用の情報を保存できませんでした。ブラウザの保存設定を確認して、もう一度「完了」を押してください。'
        : '診断結果の保存を確認できませんでした。回答はこの画面に残っています。少し時間をおいて、もう一度「完了」を押してください。');
      setLoading(false);
    } finally {
      clearTimeout(timeout);
      submittingRef.current = false;
    }
  };

  const handleCancel = () => {
    router.push('/free');
  };

  if (!initialized) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
          <p className="text-gray-700">診断を保存中...</p>
        </div>
      </div>
    );
  }

  const question = freeQuestions[currentQuestionIndex];
  const selectedChoiceIndex = answers[currentQuestionIndex];
  const canNext = selectedChoiceIndex >= 0;
  const canPrevious = currentQuestionIndex > 0;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-blue-50 to-cyan-50">
      <div className="bg-white bg-opacity-90 border border-blue-200 rounded-2xl p-8 max-w-2xl w-full">
        {/* Cancel Button */}
        <div className="flex justify-end mb-4">
          <button
            onClick={handleCancel}
            className="text-gray-400 hover:text-red-500 transition-colors text-sm flex items-center gap-1"
          >
            <span>✕</span>
            <span>キャンセル</span>
          </button>
        </div>

        {/* Progress Bar */}
        <div className="mb-6">
          <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-400 to-pink-500 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${((currentQuestionIndex + 1) / freeQuestions.length) * 100}%` }}
            >
              <div className="h-full bg-white opacity-20 animate-pulse"></div>
            </div>
          </div>
        </div>

        {/* Question Counter */}
        <div className="text-sm text-blue-600 font-semibold mb-6">
          質問 {currentQuestionIndex + 1} / {freeQuestions.length}
        </div>

        {/* Question Text */}
        <h2 className="text-2xl font-bold text-gray-900 mb-6">{question.text}</h2>

        {/* Supplement if exists */}
        {question.supplement && (
          <p className="text-gray-700 mb-6 italic text-sm">{question.supplement}</p>
        )}

        {/* Choices */}
        <div className="space-y-3 mb-8">
          {question.choices.map((choice, index) => (
            <button
              key={index}
              onClick={() => handleAnswer(index)}
              aria-pressed={selectedChoiceIndex === index}
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

        {saveError && (
          <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {saveError}
          </p>
        )}

        {/* Navigation Buttons */}
        <div className="flex gap-4">
          <button
            onClick={handlePrevious}
            disabled={!canPrevious}
            className="flex-1 py-3 px-4 bg-gray-100 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed text-gray-600 font-semibold rounded-lg transition-all duration-300"
          >
            戻る
          </button>
          <button
            onClick={handleNext}
            disabled={!canNext}
            className="flex-1 py-3 px-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all duration-300"
          >
            {currentQuestionIndex === freeQuestions.length - 1 ? '完了' : '次へ'}
          </button>
        </div>
      </div>
    </div>
  );
}
