export const DEFAULT_AUTH_REDIRECT = '/dashboard';
export const AUTH_CHECK_TIMEOUT_MS = 12000;

export function normalizeAuthRedirect(
  value: string | null | undefined,
  fallback = DEFAULT_AUTH_REDIRECT
) {
  if (!value) return fallback;

  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('/') && !decoded.startsWith('//')) {
      return decoded;
    }
  } catch {
    if (value.startsWith('/') && !value.startsWith('//')) {
      return value;
    }
  }

  return fallback;
}

export async function withAuthTimeout<T>(
  promise: PromiseLike<T>,
  message = 'ログイン状態の確認に時間がかかりすぎました。'
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), AUTH_CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
