export const COACHING_HISTORY_PAGE_SIZE = 100;
export const COACHING_HISTORY_READ_TIMEOUT_MS = 7000;
export const COACHING_HISTORY_RETRY_DELAYS_MS = [300];

type RetryClientReadOptions = {
  timeoutMs: number;
  timeoutMessage: string;
  retryDelaysMs?: number[];
  onRetry?: (error: unknown, nextAttempt: number) => void;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const createTimeoutError = (message: string) => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

export async function retryClientRead<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  options: RetryClientReadOptions
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs || [];
  let lastError: unknown = createTimeoutError(options.timeoutMessage);

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        Promise.resolve(operation(controller.signal)),
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(createTimeoutError(options.timeoutMessage));
            controller.abort();
          }, options.timeoutMs);
        }),
      ]);
    } catch (error) {
      lastError = error;
      if (attempt >= retryDelaysMs.length) throw error;

      options.onRetry?.(error, attempt + 2);
      await delay(retryDelaysMs[attempt]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  throw lastError;
}
