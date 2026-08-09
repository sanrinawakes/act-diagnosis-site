import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('../src/lib/supabase-server', () => ({
  createServerClient: mocks.createServerClient,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

import { POST as postFreeChat } from '../src/app/api/free/chat/route';
import { POST as postFreeDiagnosis } from '../src/app/api/free/diagnosis/route';

function createRequest(path: string, body: Record<string, unknown>) {
  return new NextRequest(`https://acti.example.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://acti.example.test',
    },
    body: JSON.stringify(body),
  });
}

function createBearerRequest(
  path: string,
  body: Record<string, unknown>,
  token = 'test-access-token'
) {
  return new NextRequest(`https://acti.example.test${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('free API authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
    });
  });

  it('rejects an unauthenticated free-chat request before creating an AI client', async () => {
    const response = await postFreeChat(
      createRequest('/api/free/chat', {
        email: 'someone@example.test',
        messages: [{ role: 'user', content: '相談です' }],
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('rejects an originless free-chat request without checking cookie auth', async () => {
    const response = await postFreeChat(
      createBearerRequest(
        '/api/free/chat',
        {
          email: 'someone@example.test',
          messages: [{ role: 'user', content: '相談です' }],
        },
        ''
      )
    );

    expect(response.status).toBe(403);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated free-diagnosis request before writing data', async () => {
    const response = await postFreeDiagnosis(
      createRequest('/api/free/diagnosis', {
        email: 'someone@example.test',
        answers: Array(15).fill(0),
        level: 1,
        typeCode: 'MMM',
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('does not let a signed-in user submit another person\'s email address', async () => {
    mocks.createServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1', email: 'member@example.test' } },
          error: null,
        }),
      },
    });

    const response = await postFreeChat(
      createRequest('/api/free/chat', {
        email: 'other@example.test',
        messages: [{ role: 'user', content: '相談です' }],
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('authenticates an originless automation request with its bearer token', async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: 'user-1', email: 'member@example.test' } },
      error: null,
    });
    mocks.createClient.mockReturnValue({ auth: { getUser } });

    const response = await postFreeChat(
      createBearerRequest('/api/free/chat', {
        email: 'other@example.test',
        messages: [{ role: 'user', content: '相談です' }],
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(getUser).toHaveBeenCalledWith('test-access-token');
  });
});
