export type CoachingOutputPipelineMode = 'legacy' | 'observe' | 'minimal';

export type CoachingOutputPipelineConfig = {
  mode: CoachingOutputPipelineMode;
  applySemanticNormalization: boolean;
  applyQualityRepair: boolean;
  applyQualityFallback: boolean;
  applyVerifiedResolution: boolean;
  allowNonSafetyImmediateResponses: boolean;
};

const PIPELINE_CONFIGS: Record<
  CoachingOutputPipelineMode,
  CoachingOutputPipelineConfig
> = {
  legacy: {
    mode: 'legacy',
    applySemanticNormalization: true,
    applyQualityRepair: true,
    applyQualityFallback: true,
    applyVerifiedResolution: true,
    allowNonSafetyImmediateResponses: true,
  },
  observe: {
    mode: 'observe',
    applySemanticNormalization: false,
    applyQualityRepair: false,
    applyQualityFallback: false,
    applyVerifiedResolution: false,
    allowNonSafetyImmediateResponses: true,
  },
  minimal: {
    mode: 'minimal',
    applySemanticNormalization: true,
    applyQualityRepair: false,
    applyQualityFallback: false,
    applyVerifiedResolution: true,
    allowNonSafetyImmediateResponses: true,
  },
};

export function parseCoachingOutputPipelineMode(
  value: string | undefined
): CoachingOutputPipelineMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'observe' || normalized === 'minimal'
    ? normalized
    : 'legacy';
}

export function getCoachingOutputPipelineConfig(
  env: { COACHING_OUTPUT_PIPELINE_MODE?: string } = process.env as {
    COACHING_OUTPUT_PIPELINE_MODE?: string;
  }
): CoachingOutputPipelineConfig {
  return PIPELINE_CONFIGS[
    parseCoachingOutputPipelineMode(env.COACHING_OUTPUT_PIPELINE_MODE)
  ];
}
