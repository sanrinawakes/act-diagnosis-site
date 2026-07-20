export interface ChatStreamDone {
  message?: string;
  completionStatus?: 'complete' | 'partial' | 'fallback';
  finalizationStatus?: 'complete' | 'failed';
  finishReason?: string;
  remaining?: number;
  limit?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    thoughts_tokens?: number;
    total_tokens?: number;
  };
}

type StreamEvent =
  | { type: 'chunk'; text?: string; verified?: boolean }
  | ({ type: 'done' } & ChatStreamDone)
  | { type: 'error'; error?: string };

export type ChatStreamUpdateMode = 'append' | 'replace';

export async function readChatStream(
  response: Response,
  onChunk: (text: string, mode: ChatStreamUpdateMode) => void
): Promise<ChatStreamDone> {
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    const data = await readJsonSafely(response);
    throw new Error(data?.error || data?.message || 'Failed to get response');
  }

  if (!response.body || !contentType.includes('application/x-ndjson')) {
    const data = await response.json();
    if (!data?.message || typeof data.message !== 'string') {
      throw new Error(
        'AIの応答データを確認できませんでした。もう一度お試しください。'
      );
    }
    onChunk(data.message, 'replace');
    return data;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload: ChatStreamDone = {};
  let receivedDone = false;
  let receivedText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const event = parseRequiredStreamLine(line);
      if (!event) continue;

      if (event.type === 'chunk' && event.text && event.verified === true) {
        receivedText += event.text;
        onChunk(event.text, 'append');
      }

      if (event.type === 'error') {
        throw new Error(event.error || 'AIの応答生成に失敗しました。もう一度お試しください。');
      }

      if (event.type === 'done') {
        receivedDone = true;
        donePayload = event;
      }
    }
  }

  const remaining = buffer.trim();
  if (remaining) {
    const event = parseRequiredStreamLine(remaining);
    if (event?.type === 'chunk' && event.text && event.verified === true) {
      receivedText += event.text;
      onChunk(event.text, 'append');
    }
    if (event?.type === 'error') {
      throw new Error(event.error || 'AIの応答生成に失敗しました。もう一度お試しください。');
    }
    if (event?.type === 'done') {
      receivedDone = true;
      donePayload = event;
    }
  }

  if (!receivedDone) {
    throw new Error(
      'AIの応答が途中で切れました。入力内容は保存されています。もう一度お試しください。'
    );
  }

  if (!receivedText.trim() && !donePayload.message?.trim()) {
    throw new Error(
      'AIから空の応答が返されました。入力内容は保存されています。もう一度お試しください。'
    );
  }

  const finalText = donePayload.message?.trim()
    ? donePayload.message
    : receivedText;
  if (finalText !== receivedText) {
    onChunk(finalText, 'replace');
  } else if (!receivedText) {
    onChunk(finalText, 'replace');
  }

  return donePayload;
}

async function readJsonSafely(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Partial<StreamEvent>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !['chunk', 'done', 'error'].includes(String(parsed.type || ''))
    ) {
      return null;
    }
    return parsed as StreamEvent;
  } catch {
    return null;
  }
}

function parseRequiredStreamLine(line: string) {
  if (!line.trim()) return null;
  const event = parseStreamLine(line);
  if (!event) {
    throw new Error(
      'AIの応答データが途中で壊れました。入力内容は保存されています。もう一度お試しください。'
    );
  }
  return event;
}
