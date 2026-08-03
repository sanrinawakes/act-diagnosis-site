import { describe, expect, it } from 'vitest';
import { persistChatMessageRecord } from '../src/lib/chat-message-persistence';

type SupabaseArg = Parameters<typeof persistChatMessageRecord>[0]['supabase'];

describe('persistChatMessageRecord', () => {
  it('replaces a pending system row when assistant persistence collides', async () => {
    const calls: string[] = [];
    const supabase = {
      from(table: string) {
        expect(table).toBe('chat_messages');
        return {
          insert() {
            calls.push('insert');
            return Promise.resolve({
              error: { code: '23505', message: 'duplicate key' },
            });
          },
          update(payload: Record<string, unknown>) {
            calls.push(`update:${JSON.stringify(payload)}`);
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          select() {
                            return {
                              maybeSingle: async () => ({
                                data: { id: 'assistant-1' },
                                error: null,
                              }),
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          select() {
            throw new Error('select should not run after a successful replace');
          },
        };
      },
    } as unknown as SupabaseArg;

    await persistChatMessageRecord({
      supabase,
      id: 'assistant-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '代替メッセージ',
    });

    expect(calls).toEqual([
      'insert',
      'update:{"role":"assistant","content":"代替メッセージ"}',
    ]);
  });

  it('accepts a duplicate assistant row when the same content is already saved', async () => {
    const supabase = {
      from(table: string) {
        expect(table).toBe('chat_messages');
        return {
          insert() {
            return Promise.resolve({
              error: { code: '23505', message: 'duplicate key' },
            });
          },
          update() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          select() {
                            return {
                              maybeSingle: async () => ({
                                data: null,
                                error: null,
                              }),
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({
                        data: {
                          id: 'assistant-1',
                          role: 'assistant',
                          content: '保存済みの回答',
                        },
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseArg;

    await expect(
      persistChatMessageRecord({
        supabase,
        id: 'assistant-1',
        sessionId: 'session-1',
        role: 'assistant',
        content: '保存済みの回答',
      })
    ).resolves.toBeUndefined();
  });

  it('keeps duplicate user rows idempotent', async () => {
    const calls: string[] = [];
    const supabase = {
      from() {
        return {
          insert() {
            calls.push('insert');
            return Promise.resolve({
              error: { code: '23505', message: 'duplicate key' },
            });
          },
        };
      },
    } as unknown as SupabaseArg;

    await persistChatMessageRecord({
      supabase,
      id: 'user-1',
      sessionId: 'session-1',
      role: 'user',
      content: '同じ入力',
    });

    expect(calls).toEqual(['insert']);
  });

  it('fails when the duplicate row belongs to another finalized message', async () => {
    const supabase = {
      from(table: string) {
        expect(table).toBe('chat_messages');
        return {
          insert() {
            return Promise.resolve({
              error: { code: '23505', message: 'duplicate key' },
            });
          },
          update() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          select() {
                            return {
                              maybeSingle: async () => ({
                                data: null,
                                error: null,
                              }),
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({
                        data: {
                          id: 'assistant-1',
                          role: 'assistant',
                          content: '別の本文',
                        },
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseArg;

    await expect(
      persistChatMessageRecord({
        supabase,
        id: 'assistant-1',
        sessionId: 'session-1',
        role: 'assistant',
        content: '新しい本文',
      })
    ).rejects.toThrow('CHAT_MESSAGE_PERSIST_CONFLICT');
  });
});
