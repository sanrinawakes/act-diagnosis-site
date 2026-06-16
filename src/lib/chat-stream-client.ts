export interface ChatStreamDone {
  message?: string;
  remaining?: number;
  limit?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

type StreamEvent =
  | { type: 'chunk'; text?: string }
  | ({ type: 'done' } & ChatStreamDone)
  | { type: 'error'; error?: string };

export async function readChatStream(
  response: Response,
  onChunk: (text: string) => void
): Promise<ChatStreamDone> {
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    const data = await readJsonSafely(response);
    throw new Error(data?.error || data?.message || 'Failed to get response');
  }

  if (!response.body || !contentType.includes('application/x-ndjson')) {
    const data = await response.json();
    if (data.message) onChunk(data.message);
    return data;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload: ChatStreamDone = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const event = parseStreamLine(line);
      if (!event) continue;

      if (event.type === 'chunk' && event.text) {
        onChunk(event.text);
      }

      if (event.type === 'error') {
        throw new Error(event.error || 'AIの応答生成に失敗しました。もう一度お試しください。');
      }

      if (event.type === 'done') {
        donePayload = event;
      }
    }
  }

  const remaining = buffer.trim();
  if (remaining) {
    const event = parseStreamLine(remaining);
    if (event?.type === 'chunk' && event.text) onChunk(event.text);
    if (event?.type === 'error') {
      throw new Error(event.error || 'AIの応答生成に失敗しました。もう一度お試しください。');
    }
    if (event?.type === 'done') donePayload = event;
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
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}
