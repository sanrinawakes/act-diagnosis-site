import { describe, expect, it } from 'vitest';
import { getCoachingAlertCopy } from '@/lib/coaching-gemini';

describe('getCoachingAlertCopy', () => {
  it('states that a completed provider fallback reached the user', () => {
    const copy = getCoachingAlertCopy('fallback_done', {
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      fallbackFrom: 'gemini-3.5-flash',
      provider: 'anthropic',
    });

    expect(copy.subject).toContain('予備AIへの自動切替');
    expect(copy.summary).toContain('回答を完了');
    expect(copy.summary).toContain('利用者には回答が表示');
    expect(copy.summary).not.toContain('応答失敗または中断を検知');
  });

  it('keeps incomplete fallback responses classified as failures', () => {
    const copy = getCoachingAlertCopy('fallback_done', {
      completionStatus: 'fallback',
      finalizationStatus: 'complete',
    });

    expect(copy.subject).toContain('応答失敗/中断');
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
