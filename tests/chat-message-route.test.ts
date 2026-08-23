import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getUserMock,
  maybeSingleMock,
  persistChatMessageRecordMock,
} = vi.hoisted(() => ({
  setupEnv: (() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://act-diagnosis-site.vercel.app';
  })(),
  getUserMock: vi.fn(),
  maybeSingleMock: vi.fn(),
  persistChatMessageRecordMock: vi.fn(),
}));

vi.mock('../src/lib/supabase-server', () => ({
  createServerClient: vi.fn(async () => ({
    auth: {
      getUser: getUserMock,
    },
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: maybeSingleMock,
          })),
        })),
      })),
    })),
  })),
}));

vi.mock('../src/lib/chat-message-persistence', () => ({
  persistChatMessageRecord: persistChatMessageRecordMock,
}));

import { POST } from '../src/app/api/chat/messages/route';

describe('POST /api/chat/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserMock.mockResolvedValue({
      data: { user: { id: '11111111-1111-4111-8111-111111111111' } },
      error: null,
    });
    maybeSingleMock.mockResolvedValue({
      data: { id: '22222222-2222-4222-8222-222222222222' },
      error: null,
    });
    persistChatMessageRecordMock.mockResolvedValue(undefined);
  });

  it('persists a user message for the authenticated owner', async () => {
    const response = await POST(
      new NextRequest('https://act-diagnosis-site.vercel.app/api/chat/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://act-diagnosis-site.vercel.app',
        },
        body: JSON.stringify({
          id: '33333333-3333-4333-8333-333333333333',
          sessionId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          content: '今の悩みを相談したいです。',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(persistChatMessageRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '33333333-3333-4333-8333-333333333333',
        sessionId: '22222222-2222-4222-8222-222222222222',
        role: 'user',
        content: '今の悩みを相談したいです。',
      })
    );
  });

  it('rejects unauthenticated requests', async () => {
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const response = await POST(
      new NextRequest('https://act-diagnosis-site.vercel.app/api/chat/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://act-diagnosis-site.vercel.app',
        },
        body: JSON.stringify({
          id: '33333333-3333-4333-8333-333333333333',
          sessionId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          content: '今の悩みを相談したいです。',
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(persistChatMessageRecordMock).not.toHaveBeenCalled();
  });

  it('rejects requests for another user session', async () => {
    maybeSingleMock.mockResolvedValue({
      data: null,
      error: null,
    });

    const response = await POST(
      new NextRequest('https://act-diagnosis-site.vercel.app/api/chat/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://act-diagnosis-site.vercel.app',
        },
        body: JSON.stringify({
          id: '33333333-3333-4333-8333-333333333333',
          sessionId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          content: '今の悩みを相談したいです。',
        }),
      })
    );

    expect(response.status).toBe(404);
    expect(persistChatMessageRecordMock).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads', async () => {
    const response = await POST(
      new NextRequest('https://act-diagnosis-site.vercel.app/api/chat/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://act-diagnosis-site.vercel.app',
        },
        body: JSON.stringify({
          id: 'bad',
          sessionId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          content: '',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(persistChatMessageRecordMock).not.toHaveBeenCalled();
  });

  it('accepts an assistant response for the authenticated owner session', async () => {
    const response = await POST(
      new NextRequest('https://act-diagnosis-site.vercel.app/api/chat/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://act-diagnosis-site.vercel.app',
        },
        body: JSON.stringify({
          id: '33333333-3333-4333-8333-333333333333',
          sessionId: '22222222-2222-4222-8222-222222222222',
          role: 'assistant',
          content: '利用者向けの保存済み回答',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(persistChatMessageRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '33333333-3333-4333-8333-333333333333',
        sessionId: '22222222-2222-4222-8222-222222222222',
        role: 'assistant',
        content: '利用者向けの保存済み回答',
      })
    );
  });
});
