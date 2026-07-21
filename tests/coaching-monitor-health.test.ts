import { describe, expect, it } from 'vitest';
import {
  assertHealthyCoachingMonitorResult,
  type CoachingMonitorHealthResult,
} from '@/lib/coaching-monitor-health';

const limits = { maxFirstChunkMs: 10000, maxTotalMs: 15000 };

const healthyResult: CoachingMonitorHealthResult = {
  storedMessagesBeforeReply: 81,
  storedMessagesAfterReply: 82,
  firstChunkMs: 3000,
  chatTotalMs: 3200,
  hasDone: true,
  outputChars: 40,
  returnedFallback: false,
  provider: 'gemini',
  fallbackFrom: null,
  completionStatus: 'complete',
  finalizationStatus: 'complete',
  cookieAuthUsed: true,
};

describe('assertHealthyCoachingMonitorResult', () => {
  it('accepts a normal completed response at every boundary', () => {
    expect(() =>
      assertHealthyCoachingMonitorResult(
        {
          ...healthyResult,
          firstChunkMs: limits.maxFirstChunkMs,
          chatTotalMs: limits.maxTotalMs,
          outputChars: 8,
        },
        limits
      )
    ).not.toThrow();
  });

  it('accepts a completed provider fallback within the latency limits', () => {
    expect(() =>
      assertHealthyCoachingMonitorResult(
        {
          ...healthyResult,
          returnedFallback: true,
          provider: 'anthropic',
          fallbackFrom: 'gemini-3.5-flash',
        },
        limits
      )
    ).not.toThrow();
  });

  it('still rejects a completed provider fallback that exceeds the latency limit', () => {
    expect(() =>
      assertHealthyCoachingMonitorResult(
        {
          ...healthyResult,
          returnedFallback: true,
          provider: 'anthropic',
          fallbackFrom: 'gemini-3.5-flash',
          firstChunkMs: 10001,
          chatTotalMs: 10100,
        },
        limits
      )
    ).toThrow('monitor first chunk too slow');
  });

  it('still rejects an incomplete provider fallback', () => {
    expect(() =>
      assertHealthyCoachingMonitorResult(
        {
          ...healthyResult,
          returnedFallback: true,
          provider: 'local-fallback',
          fallbackFrom: 'gemini-3.5-flash',
          completionStatus: 'fallback',
        },
        limits
      )
    ).toThrow('monitor received incomplete AI result');
  });

  it.each([
    {
      label: 'missing paid cookie authentication',
      patch: { cookieAuthUsed: false },
      error: 'monitor did not use paid cookie authentication',
    },
    {
      label: 'missing done event',
      patch: { hasDone: false },
      error: 'monitor did not receive done event',
    },
    {
      label: 'failed finalization',
      patch: { finalizationStatus: 'failed' },
      error: 'monitor did not complete chat metadata',
    },
    {
      label: 'missing first chunk timing',
      patch: { firstChunkMs: null },
      error: 'monitor first chunk too slow',
    },
    {
      label: 'slow total response',
      patch: { chatTotalMs: limits.maxTotalMs + 1 },
      error: 'monitor chat response too slow',
    },
    {
      label: 'short output',
      patch: { outputChars: 7 },
      error: 'monitor output too short',
    },
    {
      label: 'missing persisted assistant reply',
      patch: { storedMessagesAfterReply: 81 },
      error: 'monitor did not persist the complete conversation',
    },
  ])('rejects $label', ({ patch, error }) => {
    expect(() =>
      assertHealthyCoachingMonitorResult(
        { ...healthyResult, ...patch } as CoachingMonitorHealthResult,
        limits
      )
    ).toThrow(error);
  });
});
