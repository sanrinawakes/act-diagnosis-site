import { CLQuestion } from '../lib/types';

/**
 * Determine consciousness level (1-6) based on answer choice indices
 * @param answerIndices - Array of selected choice indices (0-based) for each question
 * @param questions - The consciousness questions array
 * @returns Consciousness level 1-6
 */
export function determineLevel(answerIndices: number[], questions: CLQuestion[]): number {
  const totalQuestions = questions.length;

  const levelScores = {
    level1: 0,
    level2: 0,
    level3: 0,
    level4: 0,
    level5: 0,
    level6: 0,
  };

  const level4Requirements = {
    receivesMonthlyGratitude: false,
  };

  const level5Requirements = {
    hasPublicRecognition: false,
    hasTrainedSuccessors: false,
    hasPassiveIncome: false,
    hasLifetimeAssets: false,
  };

  let negativeOneCount = 0;
  let negativeTwoCount = 0;
  let positiveAnswerCount = 0;

  let hasLevel4Check = false;
  let hasLevel5Check = false;
  let hasLevel6Check = false;

  const level3CheckScores: number[] = [];
  const level4CheckScores: number[] = [];
  const level5CheckScores: number[] = [];
  const level6CheckScores: number[] = [];

  let moneyQuestionScore: number | null = null;

  answerIndices.forEach((choiceIndex, questionIndex) => {
    if (choiceIndex < 0 || choiceIndex >= questions[questionIndex].choices.length) return;

    const question = questions[questionIndex];
    const choice = question.choices[choiceIndex];
    const score = choice.score;

    // Money question (Q17, index 16)
    if (questionIndex === 16) {
      moneyQuestionScore = score;
    }

    // Level 4 requirement check
    if (choice.isLevel4Requirement) {
      level4Requirements[choice.isLevel4Requirement as keyof typeof level4Requirements] = score === 1;
    }

    // Level 5 requirement check
    if (choice.isLevel5Requirement) {
      level5Requirements[choice.isLevel5Requirement as keyof typeof level5Requirements] = score === 1;
    }

    // Level check markers
    if (choice.isLevel4Check && score > 0) hasLevel4Check = true;
    if (choice.isLevel5Check && score > 0) hasLevel5Check = true;
    if (choice.isLevel6Check && score > 0) hasLevel6Check = true;

    // Level 3 check questions (Q35, Q36 = index 34, 35)
    if (questionIndex === 34 || questionIndex === 35) {
      level3CheckScores.push(score);
    }
    // Level 4 check questions (Q37, Q38 = index 36, 37)
    if (questionIndex === 36 || questionIndex === 37) {
      if (choice.isLevel4Check) level4CheckScores.push(score);
    }
    // Level 5 check questions (Q39, Q40 = index 38, 39)
    if (questionIndex === 38 || questionIndex === 39) {
      if (choice.isLevel5Check) level5CheckScores.push(score);
    }
    // Level 6 check questions (Q41, Q42 = index 40, 41)
    if (questionIndex === 40 || questionIndex === 41) {
      if (choice.isLevel6Check) level6CheckScores.push(score);
    }

    // Score distribution counting
    if (score === -2) {
      levelScores.level1++;
      negativeTwoCount++;
    } else if (score === -1) {
      levelScores.level2++;
      negativeOneCount++;
    } else if (score === 0) {
      levelScores.level3++;
    } else if (score === 1) {
      positiveAnswerCount++;
      if (choice.isLevel6Check) levelScores.level6++;
      else if (choice.isLevel5Check) levelScores.level5++;
      else if (choice.isLevel4Check) levelScores.level4++;
      else if (choice.isHighLevel) levelScores.level5++;
      else levelScores.level4++;
    }
  });

  // === Gate-based level determination ===

  // Level 1 gate: -2 answers >= 10% of total
  if (levelScores.level1 / totalQuestions >= 0.10) return 1;

  // Level 2 gate: -2 + -1 answers >= 30% of total
  if ((levelScores.level1 + levelScores.level2) / totalQuestions >= 0.30) return 2;

  // Negative answer thresholds
  if (negativeTwoCount >= 5) return 1;
  if (negativeTwoCount >= 3 || (negativeOneCount + negativeTwoCount) >= 10) return 2;
  if (negativeTwoCount >= 1 || (negativeOneCount + negativeTwoCount) >= 5) return 3;

  // Default level
  let determinedLevel = 3;

  // Level 3 check: Q35+Q36 scores sum >= 1
  const level3SumPositive =
    level3CheckScores.length === 2 &&
    level3CheckScores.reduce((sum, s) => sum + s, 0) >= 1;

  if (!level3SumPositive) return 2;

  // Level 4 check: both Q37 and Q38 must have isLevel4Check selected + requirement met
  const level4BothPositive =
    level4CheckScores.length === 2 && level4CheckScores.every((s) => s === 1);
  const meetsLevel4Requirements = level4Requirements.receivesMonthlyGratitude;

  // Level 5 check: both Q39 and Q40 must have isLevel5Check + all 4 requirements
  const level5BothPositive =
    level5CheckScores.length === 2 && level5CheckScores.every((s) => s === 1);
  const meetsLevel5Requirements =
    level5Requirements.hasPublicRecognition &&
    level5Requirements.hasTrainedSuccessors &&
    level5Requirements.hasPassiveIncome &&
    level5Requirements.hasLifetimeAssets;

  // Level 6 determination
  if (
    hasLevel6Check &&
    levelScores.level6 >= 3 &&
    level5BothPositive &&
    level4BothPositive &&
    meetsLevel4Requirements &&
    meetsLevel5Requirements
  ) {
    determinedLevel = 6;
  }
  // Level 5 determination
  else if (
    hasLevel5Check &&
    levelScores.level5 >= 3 &&
    level4BothPositive &&
    meetsLevel4Requirements &&
    meetsLevel5Requirements
  ) {
    determinedLevel = 5;
  }
  // Level 4 determination
  else if (hasLevel4Check && levelScores.level4 >= 3 && meetsLevel4Requirements) {
    determinedLevel = 4;
  }
  // Level 3 determination
  else if (levelScores.level3 / totalQuestions >= 0.25) {
    determinedLevel = 3;
  }

  // Money question constraint (Q17, index 16)
  if (moneyQuestionScore !== null) {
    if (moneyQuestionScore === -2) {
      determinedLevel = Math.min(determinedLevel, 2);
    } else if (moneyQuestionScore === -1) {
      const totalAnswered = answerIndices.filter(
        (ci, i) => ci >= 0 && ci < questions[i].choices.length
      ).length;
      const positiveRate = positiveAnswerCount / totalAnswered;
      if (positiveRate <= 0.7) {
        determinedLevel = Math.min(determinedLevel, 2);
      } else {
        determinedLevel = Math.min(determinedLevel, 3);
      }
    } else if (moneyQuestionScore === 0) {
      determinedLevel = Math.min(determinedLevel, 4);
    }
  }

  return determinedLevel;
}

/**
 * Determine personality type (3-letter code like "SVA") based on accumulated scores
 * @param scores - Record with keys S1, M1, P1, V2, M2, G2, A3, M3, E3
 * @returns 3-letter type code
 */
export function determineType(scores: Record<string, number>): string {
  const s1 = scores.S1 || 0;
  const p1 = scores.P1 || 0;
  const v2 = scores.V2 || 0;
  const g2 = scores.G2 || 0;
  const a3 = scores.A3 || 0;
  const e3 = scores.E3 || 0;

  // Axis 1: 行動エネルギー (S=内向型, M=中立型, P=外向型)
  // PMS = (-P1) - S1; P1 holds negative values, S1 holds positive values
  const pms = (-p1) - s1;
  const axis1 = pms >= 7 ? 'P' : pms <= -7 ? 'S' : 'M';

  // Axis 2: 思考傾向 (V=理想型, M=バランス型, G=現実型)
  // VMG = V2 + G2; V2 holds positive values, G2 holds negative values
  const vmg = v2 + g2;
  const axis2 = vmg >= 7 ? 'V' : vmg <= -7 ? 'G' : 'M';

  // Axis 3: 評価基準 (A=論理型, M=中立型, E=感情型)
  // EMA = (-E3) - A3; E3 holds negative values, A3 holds positive values
  const ema = (-e3) - a3;
  const axis3 = ema >= 7 ? 'E' : ema <= -7 ? 'A' : 'M';

  return `${axis1}${axis2}${axis3}`;
}
