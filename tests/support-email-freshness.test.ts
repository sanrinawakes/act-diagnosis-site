import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
let deliver: typeof import('../src/lib/server/support-email').deliverSupportReply;
beforeAll(async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-resend-key');
  ({ deliverSupportReply: deliver } = await import('../src/lib/server/support-email'));
});
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
it('does not call the mail provider if the ticket changed after authorization', async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: {
    id: 'ticket', email: 'member@example.com', subject: 'Question', message: 'New message',
    status: 'in_progress', updated_at: '2026-09-16T12:00:01Z',
  }, error: null }) }) }) }) };
  await expect(deliver({ adminClient: client as never, ticketId: 'ticket', subject: 'Reply',
    message: 'Answer based on an old message', senderLabel: 'test', idempotencyKey: 'test-ticket',
    statusOnSuccess: 'resolved', expectedUpdatedAt: '2026-09-16T12:00:00Z',
  })).rejects.toThrow('Ticket changed before sending');
  expect(fetch).not.toHaveBeenCalled();
});
