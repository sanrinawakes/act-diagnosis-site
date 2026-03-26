/**
 * Type names mapping - all 27 ACT subtypes
 */
export const typeNames: Record<string, string> = {
  SVA: '思索探求者',
  SVM: '慎重な調整者',
  SVE: '共感リーダー',
  SMA: '内省的戦略家',
  SMM: '平和主義の調和者',
  SME: '感性豊かな癒し手',
  SGA: '緻密な現実主義者',
  SGM: '安定志向のバランサー',
  SGE: '現場に強い共感実務家',
  MVA: '理想現実の橋渡し人',
  MVM: 'バランス思考の調整役',
  MVE: '感性とビジョンの共創者',
  MMA: '論理と実行の精密設計者',
  MMM: '中心軸を持つ均衡型',
  MME: '穏やかなる共感調整者',
  MGA: '現実に強い着実実行者',
  MGM: '堅実な安定構築者',
  MGE: '地に足ついた感情調整者',
  PVA: '革新的アイデアマン',
  PVM: '現場志向の推進者',
  PVE: '熱意あふれる表現者',
  PMA: '論理で切り拓く挑戦者',
  PMM: '行動する安定志向者',
  PME: '感情と創造の実験家',
  PGA: '結果にこだわる実行者',
  PGM: '効率的な現実構築者',
  PGE: '感情を動力にする達成者',
};

/**
 * Consciousness level names and descriptions
 */
export const levelNames: Record<number, string> = {
  1: '防衛',
  2: '著しい葛藤',
  3: '自立',
  4: '調和',
  5: '創造',
  6: '解脱（視野の超越）',
};

/**
 * Axis descriptions for the 3-letter type code
 */
export const axisDescriptions = {
  axis1: {
    description: '行動エネルギー',
    S: '内向型',
    M: '中立型',
    P: '外向型',
  },
  axis2: {
    description: '思考傾向',
    V: '理想型',
    M: 'バランス型',
    G: '現実型',
  },
  axis3: {
    description: '評価基準',
    A: '論理型',
    M: '中立型',
    E: '感情型',
  },
};

/**
 * Type names mapping - English versions of all 27 ACT subtypes
 */
export const typeNamesEn: Record<string, string> = {
  SVA: 'Reflective Seeker',
  SVM: 'Cautious Coordinator',
  SVE: 'Empathic Leader',
  SMA: 'Introspective Strategist',
  SMM: 'Peaceful Harmonizer',
  SME: 'Sensitive Healer',
  SGA: 'Meticulous Realist',
  SGM: 'Stability-Oriented Balancer',
  SGE: 'On-the-Ground Empathic Practitioner',
  MVA: 'Bridge Between Ideals and Reality',
  MVM: 'Balanced Thinker & Mediator',
  MVE: 'Co-Creator of Sensitivity and Vision',
  MMA: 'Precision Architect of Logic and Execution',
  MMM: 'Centered Equilibrium Type',
  MME: 'Gentle Empathic Mediator',
  MGA: 'Grounded Steady Executor',
  MGM: 'Solid Stability Builder',
  MGE: 'Down-to-Earth Emotional Regulator',
  PVA: 'Innovative Idea Generator',
  PVM: 'Field-Oriented Driver',
  PVE: 'Passionate Expressionist',
  PMA: 'Logic-Driven Challenger',
  PMM: 'Action-Oriented Stabilizer',
  PME: 'Emotion & Creativity Experimenter',
  PGA: 'Results-Focused Executor',
  PGM: 'Efficient Reality Builder',
  PGE: 'Emotion-Fueled Achiever',
};

/**
 * Consciousness level names - English versions
 */
export const levelNamesEn: Record<number, string> = {
  1: 'Defense',
  2: 'Significant Inner Conflict',
  3: 'Independence',
  4: 'Harmony',
  5: 'Creation',
  6: 'Liberation (Transcendence of Perspective)',
};

/**
 * Axis descriptions - English versions for the 3-letter type code
 */
export const axisDescriptionsEn = {
  axis1: {
    description: 'Behavioral Energy',
    S: 'Introverted',
    M: 'Balanced',
    P: 'Extroverted',
  },
  axis2: {
    description: 'Thinking Style',
    V: 'Idealistic',
    M: 'Balanced',
    G: 'Realistic',
  },
  axis3: {
    description: 'Evaluation Criteria',
    A: 'Logic-Oriented',
    M: 'Balanced',
    E: 'Emotion-Oriented',
  },
};
