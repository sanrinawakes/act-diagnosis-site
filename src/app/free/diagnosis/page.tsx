'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { consciousnessQuestions } from '@/data/consciousness-questions';
import type { CLQuestion } from '@/lib/types';

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
  const [answers, setAnswers] = useState<number[]>(Array(freeQuestions.length).fill(-999));
  const [loading, setLoading] = useState(false);
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
      setInitialized(true);
    };

    getUser();
  }, [router, supabase]);

  const handleAnswer = (choiceIndex: number) => {
    const newAnswers = [...answers];
    const question = freeQuestions[currentQuestionIndex];
    newAnswers[currentQuestionIndex] = question.choices[choiceIndex].score;
    setAnswers(newAnswers);
  };

  const handleNext = async () => {
    if (currentQuestionIndex < freeQuestions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      // All questions answered - save results
      await handleSubmit();
    }
  };

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
    }
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      // Calculate consciousness level
      // Count answers with score -2: if >= 3, level = 1, else level = 2
      const lowScoreCount = answers.filter((score) => score === -2).length;
      const level: DiagnosisResult['level'] = lowScoreCount >= 3 ? 1 : 2;

      // For free version, use fixed type code "MMM" (center equilibrium)
      const typeCode = 'MMM';

      const result: DiagnosisResult = {
        level,
        typeCode,
      };

      // Save to localStorage
      localStorage.setItem('free_diagnosis_result', JSON.stringify(result));

      // Call API to save diagnosis
      const response = await fetch('/api/free/diagnosis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email || '',
          level: level,
          typeCode: typeCode,
          answers: answers,
        }),
      });

      if (!response.ok) {
        console.error('Failed to save diagnosis');
      }

      // Redirect to results page
      router.push('/free/results');
    } catch (error) {
      console.error('Error saving diagnosis:', error);
      setLoading(false);
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
  const selectedChoiceIndex =
    answers[currentQuestionIndex] === -999
      ? -1
      : question.choices.findIndex((c) => c.score === answers[currentQuestionIndex]);
  const canNext = answers[currentQuestionIndex] !== -999;
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
