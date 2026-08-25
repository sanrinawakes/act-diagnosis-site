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

    expect(result.modelName).toBe('local-quality-fallback');
    expect(result.provider).toBe('local');
    expect(result.chargeable).toBe(false);
    expect(result.text).not.toMatch(/保存済み要約|ACTI_SESSION_MEMORY/);
  });

  it('minimalでも話題ずれと不満が観測されたらverified fallbackへ戻す', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';

    const repeated =
      '現在の支払い分担について、口頭のお願い以外に確認できる合意や記録はありますか？';
    const historyMessages = [
      {
        role: 'user' as const,
        content: '以前、夫が家賃を払わないことで困っていました。',
      },
      { role: 'assistant' as const, content: repeated },
      {
        role: 'user' as const,
        content:
          '今回は講座に申し込まなかった後悔と、スピリチュアルな学びにこれ以上お金を使いたくない疲れ、お金が入ってこない不安の話です。',
      },
      { role: 'assistant' as const, content: repeated },
      { role: 'user' as const, content: '支払い分担って何の話？' },
      { role: 'assistant' as const, content: repeated },
      {
        role: 'user' as const,
        content: 'なんで私ばっかりお金が入ってこないの、という話です。',
      },
      { role: 'assistant' as const, content: repeated },
    ];
    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: 'こちらの確認が噛み合っておらず、大変失礼いたしました。\n\n講座に申し込まなかった後悔や、スピリチュアルな学びにこれ以上お金を使いたくない疲れ、そしてお金が入ってこない不安について話してくださっていたのですね。\n\nお金が入ってこない不安について、今一番困っている出来事は何ですか？',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        modelName: 'gemini-3.5-flash',
        provider: 'gemini',
        repairAttempted: false,
        repairAccepted: false,
        initialIssues: [
          'too_short',
          'repeats_rejected_move',
          'dissatisfaction_unanswered',
        ],
        finalIssues: [
          'too_short',
          'repeats_rejected_move',
          'dissatisfaction_unanswered',
        ],
      },
      lastUserText: '本当に何の話？',
      historyMessages,
      preserveUsage: true,
    });

    expect(result.modelName).toBe('local-quality-fallback');
    expect(result.provider).toBe('local');
    expect(result.chargeable).toBe(false);
    expect(result.text).toContain('講座への申し込みを保留');
    expect(result.text).toContain('現在の収入源');
    expect(result.text).toContain('今月必要な金額');
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
