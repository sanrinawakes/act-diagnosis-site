import { describe, expect, it } from 'vitest';
import {
  getCoachingAlertThrottleKind,
  getCoachingAlertCopy,
  shouldAlertForCoachingTelemetry,
} from '@/lib/coaching-gemini';

describe('getCoachingAlertCopy', () => {
  it('states that a completed provider fallback reached the user', () => {
    const payload = {
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      fallbackFrom: 'gemini-3.5-flash',
      provider: 'anthropic',
      elapsedMs: 5000,
    };
    const copy = getCoachingAlertCopy('fallback_done', payload);

    expect(copy.subject).toContain('予備AIへの自動切替');
    expect(copy.summary).toContain('回答を完了');
    expect(copy.summary).toContain('利用者には回答が表示');
    expect(copy.summary).not.toContain('応答失敗または中断を検知');
    expect(shouldAlertForCoachingTelemetry('fallback_done', payload)).toBe(
      false
    );
  });

  it('classifies a completed but slow provider fallback as latency', () => {
    const payload = {
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      fallbackFrom: 'gemini-3.5-flash',
      provider: 'anthropic',
      elapsedMs: 10001,
    };
    const copy = getCoachingAlertCopy('fallback_done', payload);

    expect(copy.subject).toContain('自動復旧');
    expect(copy.subject).toContain('遅延');
    expect(copy.subject).not.toContain('失敗');
    expect(copy.summary).toContain('回答を完了');
    expect(shouldAlertForCoachingTelemetry('fallback_done', payload)).toBe(
      true
    );
    expect(getCoachingAlertThrottleKind('fallback_done', payload)).toBe(
      'provider_fallback_recovered_slow'
    );
  });

  it('keeps incomplete fallback responses classified as failures', () => {
    const payload = {
      completionStatus: 'fallback',
      finalizationStatus: 'complete',
      elapsedMs: 5000,
    };
    const copy = getCoachingAlertCopy('fallback_done', payload);

    expect(copy.subject).toContain('応答失敗/中断');
    expect(shouldAlertForCoachingTelemetry('fallback_done', payload)).toBe(
      true
    );
    expect(getCoachingAlertThrottleKind('fallback_done', payload)).toBe(
      'fallback_done'
    );
  });

  it('prioritizes a failed finalization over provider recovery', () => {
    const copy = getCoachingAlertCopy('fallback_done', {
      completionStatus: 'complete',
      finalizationStatus: 'failed',
      provider: 'anthropic',
    });

    expect(copy.subject).toContain('会話後処理の失敗');
  });
});
