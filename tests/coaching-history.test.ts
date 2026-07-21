import { describe, expect, it, vi } from 'vitest';
import { retryClientRead } from '@/lib/coaching-history';

describe('retryClientRead', () => {
  it('aborts a timed-out read and succeeds on the retry', async () => {
    let attempts = 0;
    let firstAttemptAborted = false;
    const onRetry = vi.fn();

    const result = await retryClientRead(
      (signal) => {
        attempts += 1;
        if (attempts === 2) return Promise.resolve('loaded');

        return new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            firstAttemptAborted = true;
            reject(new Error('request aborted'));
          });
        });
      },
      {
        timeoutMs: 10,
        timeoutMessage: 'history timed out',
        retryDelaysMs: [0],
        onRetry,
      }
    );

    expect(result).toBe('loaded');
    expect(attempts).toBe(2);
    expect(firstAttemptAborted).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 2);
  });

  it('retries a transient rejected read once', async () => {
    let attempts = 0;

    const result = await retryClientRead(
      () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new TypeError('fetch failed'));
        return Promise.resolve({ rows: 8 });
      },
      {
        timeoutMs: 100,
        timeoutMessage: 'history timed out',
        retryDelaysMs: [0],
      }
    );

    expect(result).toEqual({ rows: 8 });
    expect(attempts).toBe(2);
  });

  it('returns the final timeout after all attempts are exhausted', async () => {
    let attempts = 0;

    await expect(
      retryClientRead(
        (signal) => {
          attempts += 1;
          return new Promise<string>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
        {
          timeoutMs: 5,
          timeoutMessage: 'history timed out',
          retryDelaysMs: [0],
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError', message: 'history timed out' });

    expect(attempts).toBe(2);
  });
});
