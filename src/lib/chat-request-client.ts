const DEFAULT_RETRY_DELAYS_MS = [700, 1800] as const;

type ConnectChatParams = {
  body: Record<string, unknown>;
  timeoutMs: number;
  timeoutMessage: string;
  retryDelaysMs?: readonly number[];
  fetchFn?: typeof fetch;
  delayFn?: (ms: number) => Promise<void>;
};

type ConnectChatResult = {
  response: Response;
  controller: AbortController;
  attempts: number;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function connectChatWithRecovery(
  params: ConnectChatParams
): Promise<ConnectChatResult> {
  const fetchFn = params.fetchFn || fetch;
  const delayFn = params.delayFn || delay;
  const retryDelaysMs = params.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  const serializedBody = JSON.stringify(params.body);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const response = await Promise.race([
        fetchFn('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
          },
          credentials: 'same-origin',
          body: serializedBody,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new DOMException(params.timeoutMessage, 'AbortError'));
          }, params.timeoutMs);
        }),
      ]);

      if (
        response.status === 409 &&
        response.headers.get('x-acti-chat-status') === 'pending' &&
        attempt < retryDelaysMs.length
      ) {
        await response.body?.cancel().catch(() => {});
        await delayFn(retryDelaysMs[attempt]);
        continue;
      }

      return {
        response,
        controller,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      if (
        attempt >= retryDelaysMs.length ||
        !isRetryableChatConnectionError(error)
      ) {
        throw error;
      }
      await delayFn(retryDelaysMs[attempt]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  throw lastError;
}

export function isRetryableChatConnectionError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof TypeError &&
    /Failed to fetch|Load failed|NetworkError|Network request failed/i.test(
      error.message
    )
  );
}

export function getUserFacingChatError(error: unknown) {
  if (!(error instanceof Error) || !error.message) {
    return '送信に失敗しました。入力内容は保存されています。少し待ってから、もう一度送信してください。';
  }

  if (
    /Failed to fetch|Load failed|NetworkError|Network request failed/i.test(
      error.message
    )
  ) {
    return '通信が一時的に切れました。相談内容は保存されています。通信状態を確認して、もう一度送信してください。';
  }

  if (/Unauthorized|ログインが必要/.test(error.message)) {
    return 'ログイン状態を確認できませんでした。入力内容は保存されています。画面を再読み込みして、もう一度送信してください。';
  }

  if (/Failed to get response|Internal server error/.test(error.message)) {
    return 'サーバーから回答を受け取れませんでした。入力内容は保存されています。少し待ってから、もう一度送信してください。';
  }

  if (/Invalid diagnosis code/.test(error.message)) {
    return '診断情報を確認できませんでした。入力内容は保存されています。画面を再読み込みして、もう一度送信してください。';
  }

  return error.message;
}
