import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  buildSupportDecisionEmailText,
  deliverSupportDecisionRequest,
  getSupportDecisionEmails,
} from '@/lib/server/support-decision-email';

const ticket = {
  id: 'ad7c4e6a-8f28-4594-9676-a7a1e20b25ba',
  name: '確認 太郎',
  email: 'customer@example.com',
  category: 'billing',
  subject: '追加利用の料金について',
};

describe('support business decision notification', () => {
  it('deduplicates and validates configured recipients', () => {
    expect(
      getSupportDecisionEmails(
        '181wyc@gmail.com, 181wyc@gmail.com, invalid,STAFF@example.com'
      )
    ).toEqual(['181wyc@gmail.com', 'staff@example.com']);
  });

  it('builds a concrete question with the ticket identifier and admin link', () => {
    const text = buildSupportDecisionEmailText({
      ticket,
      reason:
        '追加100回の価格を1,000円にするか、1,500円にするか決定してください。',
      adminUrl: 'https://act-diagnosis-site.vercel.app/admin/support',
    });

    expect(text).toContain(ticket.id);
    expect(text).toContain(ticket.subject);
    expect(text).toContain('判断してほしいこと');
    expect(text).toContain('追加100回の価格');
    expect(text).toContain('/admin/support');
    expect(text).toContain('顧客への確約や料金・契約の変更は行いません');
  });

  it('uses a stable provider idempotency key and the decision-only recipient', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.to).toEqual(['181wyc@gmail.com']);
      expect(body.subject).toBe(
        '[ACTI 判断依頼] 追加利用の料金について'
      );
      expect(
        (init?.headers as Record<string, string>)['Idempotency-Key']
      ).toBe(`support-decision-${ticket.id}`);

      return new Response(JSON.stringify({ id: 'email-decision-test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await deliverSupportDecisionRequest({
      ticket,
      reason: '料金を決定してください。',
      apiKey: 'resend-test-key',
      fromEmail: 'noreply@silversense.cc',
      recipients: ['181wyc@gmail.com'],
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      idempotencyKey: `support-decision-${ticket.id}`,
      resendId: 'email-decision-test',
      recipients: ['181wyc@gmail.com'],
    });
  });

  it('does not report success when the decision notification fails', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'provider rejected' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      deliverSupportDecisionRequest({
        ticket,
        reason: '料金を決定してください。',
        apiKey: 'resend-test-key',
        recipients: ['181wyc@gmail.com'],
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toThrow('Decision notification failed (403)');
  });
});
