import { afterEach, describe, expect, it } from 'vitest';
import {
  COACHING_IMAGE_TEMPERATURE,
  COACHING_IMAGE_THINKING_LEVEL,
  COACHING_IMAGE_TOP_P,
  GEMINI_IMAGE_TIMEOUT_MS,
  getCoachingTextModelConfig,
} from '../src/lib/coaching-model-config';
import {
  buildGeminiParts,
  getCoachingGeminiModelName,
} from '../src/lib/coaching-gemini';

afterEach(() => {
  delete process.env.COACHING_TEXT_MODEL;
  delete process.env.COACHING_TEXT_THINKING_LEVEL;
  delete process.env.COACHING_TEXT_TEMPERATURE;
  delete process.env.COACHING_TEXT_TOP_P;
  delete process.env.GEMINI_TEXT_TIMEOUT_MS;
});

describe('coaching model configuration', () => {
  it('テキスト既定値を会話品質寄せにする', () => {
    expect(getCoachingTextModelConfig({})).toEqual({
      model: 'gemini-3.5-flash',
      thinkingLevel: 'low',
      temperature: 0.7,
      topP: 0.95,
      timeoutMs: 22000,
    });
  });

  it('テキスト主モデルと生成設定を環境変数で上書きできる', () => {
    process.env.COACHING_TEXT_MODEL = 'gemini-test-model';
    process.env.COACHING_TEXT_THINKING_LEVEL = 'medium';
    process.env.COACHING_TEXT_TEMPERATURE = '0.55';
    process.env.COACHING_TEXT_TOP_P = '0.9';
    process.env.GEMINI_TEXT_TIMEOUT_MS = '18000';

    expect(getCoachingTextModelConfig()).toEqual({
      model: 'gemini-test-model',
      thinkingLevel: 'medium',
      temperature: 0.55,
      topP: 0.9,
      timeoutMs: 18000,
    });
    expect(getCoachingGeminiModelName(buildGeminiParts('相談です。', []))).toBe(
      'gemini-test-model'
    );
  });

  it('不正な上書き値は既定値へ戻す', () => {
    expect(
      getCoachingTextModelConfig({
        COACHING_TEXT_THINKING_LEVEL: 'high',
        COACHING_TEXT_TEMPERATURE: '3',
        COACHING_TEXT_TOP_P: '-1',
        GEMINI_TEXT_TIMEOUT_MS: '500',
      })
    ).toMatchObject({
      thinkingLevel: 'low',
      temperature: 0.7,
      topP: 0.95,
      timeoutMs: 22000,
    });
  });

  it('画像生成設定は従来値を維持する', () => {
    expect(COACHING_IMAGE_THINKING_LEVEL).toBe('minimal');
    expect(COACHING_IMAGE_TEMPERATURE).toBe(0.2);
    expect(COACHING_IMAGE_TOP_P).toBe(0.8);
    expect(GEMINI_IMAGE_TIMEOUT_MS).toBe(20000);
  });
});
