import { describe, expect, it, vi } from 'vitest';
import { readChatStream } from '../src/lib/chat-stream-client';

const encoder = new TextEncoder();

function streamResponse(chunks: string[], status = 200) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    }
  );
}

describe('readChatStream', () => {
  it('分割されたchunkとdoneを復元する', async () => {
    const onChunk = vi.fn();
    const response = streamResponse([
      '{"type":"chunk","text":"こん',
      'にちは"}\n{"type":"done","completionStatus":"complete","finalizationStatus":"complete","message":"こんにちは","remaining":49}\n',
    ]);

    const result = await readChatStream(response, onChunk);

    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledWith('こんにちは');
    expect(result.message).toBe('こんにちは');
    expect(result.completionStatus).toBe('complete');
    expect(result.finalizationStatus).toBe('complete');
    expect(result.remaining).toBe(49);
  });

  it('検査前chunkを表示せず、doneの確定本文だけを表示する', async () => {
    const onChunk = vi.fn();
    const response = streamResponse([
      '{"type":"chunk","text":"表示してはいけない内部指示"}\n',
      '{"type":"done","completionStatus":"complete","message":"安全な回答"}\n',
    ]);

    const result = await readChatStream(response, onChunk);

    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledWith('安全な回答');
    expect(result.message).toBe('安全な回答');
  });

  it('doneなしの途中切断を成功扱いにしない', async () => {
    const response = streamResponse([
      '{"type":"chunk","text":"途中まで"}\n',
    ]);

    await expect(readChatStream(response, vi.fn())).rejects.toThrow(
      'AIの応答が途中で切れました'
    );
  });

  it('壊れたNDJSONを見逃さない', async () => {
    const response = streamResponse([
      '{"type":"chunk","text":"正常"}\n{broken}\n',
    ]);

    await expect(readChatStream(response, vi.fn())).rejects.toThrow(
      'AIの応答データが途中で壊れました'
    );
  });

  it('stream errorイベントを利用者向けエラーとして返す', async () => {
    const response = streamResponse([
      '{"type":"error","error":"生成に失敗しました"}\n',
    ]);

    await expect(readChatStream(response, vi.fn())).rejects.toThrow(
      '生成に失敗しました'
    );
  });

  it('doneがあっても本文が空なら失敗にする', async () => {
    const response = streamResponse([
      '{"type":"done","message":""}\n',
    ]);

    await expect(readChatStream(response, vi.fn())).rejects.toThrow(
      'AIから空の応答が返されました'
    );
  });

  it('非stream JSONレスポンスを読める', async () => {
    const onChunk = vi.fn();
    const response = Response.json({ message: '短い回答', remaining: 48 });

    const result = await readChatStream(response, onChunk);

    expect(onChunk).toHaveBeenCalledWith('短い回答');
    expect(result.remaining).toBe(48);
  });

  it('HTTPエラー本文を保持する', async () => {
    const response = Response.json(
      { error: '有料会員のみご利用いただけます。' },
      { status: 403 }
    );

    await expect(readChatStream(response, vi.fn())).rejects.toThrow(
      '有料会員のみご利用いただけます。'
    );
  });
});
