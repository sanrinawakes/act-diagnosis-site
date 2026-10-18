export type CoachingOutputPipelineMode =
  | 'safety'
  | 'legacy'
  | 'observe'
  | 'minimal';

export type CoachingOutputPipelineConfig = {
  mode: CoachingOutputPipelineMode;
  applySemanticNormalization: boolean;
  applyQualityRepair: boolean;
  applyQualityFallback: boolean;
  applyVerifiedResolution: boolean;
  allowNonSafetyImmediateResponses: boolean;
};

export const DEFAULT_COACHING_OUTPUT_PIPELINE_MODE: CoachingOutputPipelineMode =
  'safety';

const PIPELINE_CONFIGS: Record<
  CoachingOutputPipelineMode,
  CoachingOutputPipelineConfig
> = {
  // Default. Only the customer-safety boundaries may replace model output:
  // urgent safety situations, internal prompt/context exposure, and unsafe
  // high-impact advice. Every other quality finding is recorded in telemetry
  // as an observed issue, but the model's answer is delivered as written.
  // Non-safety local replies (theme menus, canned follow-ups, retry notices)
  // are never used, so the customer always gets a conversation, not a notice.
  safety: {
    mode: 'safety',
    applySemanticNormalization: false,
    applyQualityRepair: false,
    applyQualityFallback: false,
    applyVerifiedResolution: false,
    allowNonSafetyImmediateResponses: false,
  },
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
  return normalized === 'legacy' ||
    normalized === 'observe' ||
    normalized === 'minimal' ||
    normalized === 'safety'
    ? normalized
    : DEFAULT_COACHING_OUTPUT_PIPELINE_MODE;
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
