import { CLQuestion } from '../lib/types';

/**
 * Free version scoring - always returns level 1 or 2
 * Uses the same basic logic as the full version but caps at level 2
 */
export function determineFreeLevel(answerIndices: number[], questions: CLQuestion[]): number {
  let negativeTwoCount = 0;
  let negativeOneCount = 0;

  answerIndices.forEach((choiceIndex, questionIndex) => {
    if (choiceIndex < 0 || choiceIndex >= questions[questionIndex].choices.length) return;
    const score = questions[questionIndex].choices[choiceIndex].score;
    if (score === -2) negativeTwoCount++;
    if (score === -1) negativeOneCount++;
  });

  // If many -2 answers, definitely level 1
  if (negativeTwoCount >= 3) return 1;
  // Otherwise level 2 (never higher for free version)
  return 2;
}
