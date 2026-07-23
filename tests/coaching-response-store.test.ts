import { describe, expect, it } from 'vitest';
import {
  classifyStoredCoachingResponse,
  createCachedCoachingStream,
} from '../src/lib/coaching-response-store';
import { readChatStream } from '../src/lib/chat-stream-client';

const NOW = Date.parse('2026-07-23T02:00:00Z');

describe('classifyStoredCoachingResponse', () => {
  it('recognizes a completed assistant response', () => {
    expect(
      classifyStoredCoachingResponse(
        {
          id: '11111111-1111-4111-8111-111111111111',
          role: 'assistant',
          content: '保存済みの回答です。',
          created_at: '2026-07-23T01:59:00Z',
        },
        NOW
      )
    ).toEqual({
      status: 'complete',
      messageId: '11111111-1111-4111-8111-111111111111',
      message: '保存済みの回答です。',
    });
  });

  it('does not take over an active request before the server timeout window', () => {
    expect(
      classifyStoredCoachingResponse(
        {
          id: '11111111-1111-4111-8111-111111111111',
          role: 'system',
          content:
            '__ACTI_COACHING_RESPONSE_PENDING__:22222222-2222-4222-8222-222222222222',
          created_at: '2026-07-23T01:59:10Z',
        },
        NOW
      ).status
    ).toBe('pending');
  });

  it('allows a new worker to take over only after the original request is stale', () => {
    expect(
      classifyStoredCoachingResponse(
        {
          id: '11111111-1111-4111-8111-111111111111',
          role: 'system',
          content:
            '__ACTI_COACHING_RESPONSE_PENDING__:22222222-2222-4222-8222-222222222222',
          created_at: '2026-07-23T01:58:49Z',
        },
        NOW
      ).status
    ).toBe('stale');
  });
});

describe('createCachedCoachingStream', () => {
  it('replays one saved response as a complete NDJSON stream', async () => {
    const chunks: string[] = [];
    const response = new Response(
      createCachedCoachingStream({
        message: '保存済みの回答です。',
        remaining: 42,
        limit: 50,
      }),
      {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
        },
      }
    );

    const done = await readChatStream(response, (text) => chunks.push(text));

    expect(chunks).toEqual(['保存済みの回答です。']);
    expect(done).toMatchObject({
      message: '保存済みの回答です。',
      completionStatus: 'complete',
      finalizationStatus: 'complete',
      finishReason: 'CACHED_REPLAY',
      remaining: 42,
      limit: 50,
    });
  });
});
