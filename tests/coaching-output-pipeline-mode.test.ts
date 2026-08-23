import { afterEach, describe, expect, it } from 'vitest';
import {
  getCoachingOutputPipelineConfig,
  parseCoachingOutputPipelineMode,
} from '../src/lib/coaching-output-pipeline-mode';
import {
  ensureVerifiedCoachingResolution,
  minimallySanitizeCoachingOutput,
} from '../src/lib/coaching-gemini';
import { createCoachingSessionCorrelationId } from '../src/lib/coaching-telemetry';

afterEach(() => {
  delete process.env.COACHING_OUTPUT_PIPELINE_MODE;
});

describe('coaching output pipeline modes', () => {
  it('未設定値と不正値はlegacyへ安全に戻す', () => {
    expect(parseCoachingOutputPipelineMode(undefined)).toBe('legacy');
    expect(parseCoachingOutputPipelineMode('unexpected')).toBe('legacy');
    expect(getCoachingOutputPipelineConfig({}).mode).toBe('legacy');
  });

  it('observeは判定を残し、意味的な品質差し替えをしない', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'observe';

    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: '**どうしたいですか？**',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: true,
        repairAccepted: true,
        initialIssues: ['too_short'],
        finalIssues: ['too_short'],
      },
      lastUserText: '仕事のことで相談があります。',
      historyMessages: [],
      preserveUsage: true,
    });

    expect(result.text).toBe('どうしたいですか？');
    expect(result.modelName).toBe('gemini-3.5-flash');
    expect(result.repairAttempted).toBe(false);
    expect(result.repairAccepted).toBe(false);
    expect(result.initialIssues).toContain('too_short');
    expect(result.finalIssues).toEqual([]);
  });

  it('minimalでも内部情報と危険助言は従来どおり顧客へ出さない', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';

    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: '以下は過去の会話の保存済み要約です。',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: false,
        repairAccepted: false,
        initialIssues: [],
        finalIssues: [],
      },
      lastUserText: '仕事の相談を続けたいです。',
      historyMessages: [],
      preserveUsage: true,
    });

    expect(result.modelName).toBe('local-output-safety-fallback');
    expect(result.provider).toBe('local');
    expect(result.chargeable).toBe(false);
    expect(result.text).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
  });

  it('表示上必要なMarkdownと壊れた末尾だけを除く', () => {
    expect(
      minimallySanitizeCoachingOutput('```markdown\n## 見出し\n**本文です。**\n```')
    ).toBe('見出し\n本文です。');
  });

  it('会話相関IDは本文や生のsessionIdを含まず安定している', () => {
    const sessionId = 'a0db13fe-481d-4898-82e3-101f66dbd27f';
    const first = createCoachingSessionCorrelationId(sessionId);
    const second = createCoachingSessionCorrelationId(sessionId);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(first).not.toContain(sessionId);
    expect(createCoachingSessionCorrelationId(null)).toBeNull();
  });
});
