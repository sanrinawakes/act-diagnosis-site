import { describe, expect, it, vi } from 'vitest';
import {
  appendSupportInboundLog,
  buildSupportInboundReplyAddress,
  detectImageMimeType,
  extractCustomerReplyText,
  extractMailboxAddress,
  extractSupportInboundCustomerMessages,
  hasSupportInboundEmail,
  parseSupportInboundReplyAddress,
  validateInboundImageBytes,
} from '@/lib/support-inbound';
import {
  processSupportInboundEmail,
  type InboundSupportTicket,
  type ReceivedSupportEmail,
  type SupportInboundDependencies,
} from '@/lib/support-inbound-processor';
import { splitSupportMessage } from '@/lib/support-reply-log';
import { buildSupportReceiptMessage } from '@/lib/support-receipt';

const ticketId = '22dcce07-e81e-4c12-8a4a-c4385e8305de';
const receivedEmailId = '72184d59-6610-4c8b-b84f-da050aca5400';
const secret = 'test-secret-with-at-least-32-characters';
const domain = 'reply.silversense.cc';

describe('support inbound reply address', () => {
  it('builds and verifies a ticket-specific address within the local-part limit', () => {
    const address = buildSupportInboundReplyAddress({
      ticketId,
      domain,
      secret,
    });

    expect(address.split('@')[0].length).toBeLessThanOrEqual(64);
    expect(
      parseSupportInboundReplyAddress({
        addresses: [`ACTI Support <${address.toUpperCase()}>`],
        domain: 'REPLY.SILVERSENSE.CC.',
        secret,
      })
    ).toEqual({
      ticketId,
      address,
    });
  });

  it('rejects a changed token, a different domain, and malformed ticket ids', () => {
    const address = buildSupportInboundReplyAddress({
      ticketId,
      domain,
      secret,
    });
    const changedAddress = address.replace(/.@reply/, 'x@reply');

    expect(
      parseSupportInboundReplyAddress({
        addresses: [changedAddress],
        domain,
        secret,
      })
    ).toBeNull();
    expect(
      parseSupportInboundReplyAddress({
        addresses: [address],
        domain: 'other.silversense.cc',
        secret,
      })
    ).toBeNull();
    expect(() =>
      buildSupportInboundReplyAddress({
        ticketId: 'not-a-ticket',
        domain,
        secret,
      })
    ).toThrow('Invalid support ticket ID');
  });

  it('extracts a normalized mailbox from a display-name address', () => {
    expect(extractMailboxAddress('山田 花子 <Member.Example+ACTI@gmail.com>')).toBe(
      'member.example+acti@gmail.com'
    );
  });
});

describe('support inbound reply body', () => {
  it('keeps the new Japanese reply and removes the quoted prior email', () => {
    expect(
      extractCustomerReplyText({
        text: [
          'ご対応ありがとうございます。',
          '追加で、画像の状態も確認してください。',
          '',
          'On Sat, Jul 25, 2026 at 10:00 AM ACTI サポート wrote:',
          '> お問い合わせを受け付けました。',
        ].join('\r\n'),
      })
    ).toBe(
      'ご対応ありがとうございます。\n追加で、画像の状態も確認してください。'
    );
  });

  it('removes an HTML blockquote when a plain-text body is unavailable', () => {
    expect(
      extractCustomerReplyText({
        html: [
          '<div>まだ同じエラーが出ます。<br>再確認をお願いします。</div>',
          '<blockquote>過去の返信です。</blockquote>',
        ].join(''),
      })
    ).toBe('まだ同じエラーが出ます。\n再確認をお願いします。');
  });

  it('does not remove an ordinary sentence containing the word From', () => {
    expect(
      extractCustomerReplyText({
        text: 'Fromという表示が画面に出ています。\nこの部分を確認してください。',
      })
    ).toBe('Fromという表示が画面に出ています。\nこの部分を確認してください。');
  });
});

describe('support receipt message', () => {
  it('sets the initial expectation that investigation may take two to three days', () => {
    const message = buildSupportReceiptMessage({
      name: '山田花子',
      ticketId,
    });

    expect(message).toContain('対応完了まで2〜3日かかる場合があります。');
    expect(message).toContain(
      '対応が完了しましたら、このメールアドレスへ改めてご連絡します。'
    );
    expect(message).not.toContain('直りました');
  });
});

describe('support inbound history', () => {
  it('appends a customer reply once and exposes it to automation policy checks', () => {
    const first = appendSupportInboundLog('最初の問い合わせ', {
      receivedAt: '2026-07-25T12:00:00.000Z',
      senderEmail: 'member@example.com',
      toEmail: 'ticket@example.com',
      subject: 'Re: 不具合',
      body: 'まだ直っていません。',
      receivedEmailId,
      webhookId: 'msg_webhook_001',
    });
    const duplicate = appendSupportInboundLog(first, {
      receivedAt: '2026-07-25T12:00:00.000Z',
      senderEmail: 'member@example.com',
      toEmail: 'ticket@example.com',
      subject: 'Re: 不具合',
      body: 'まだ直っていません。',
      receivedEmailId,
      webhookId: 'msg_webhook_001',
    });
    const parsed = splitSupportMessage(first);

    expect(duplicate).toBe(first);
    expect(hasSupportInboundEmail(first, receivedEmailId)).toBe(true);
    expect(extractSupportInboundCustomerMessages(parsed.replyLog)).toEqual([
      'まだ直っていません。',
    ]);
  });

  it('detects real image signatures instead of trusting file names', () => {
    expect(
      detectImageMimeType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe('image/png');
    expect(
      detectImageMimeType(
        new TextEncoder().encode('<script>alert("not an image")</script>')
      )
    ).toBeNull();
  });

  it('rejects an image whose declared type differs from its bytes', () => {
    expect(() =>
      validateInboundImageBytes({
        bytes: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]),
        declaredMimeType: 'image/jpeg',
        declaredSize: 8,
      })
    ).toThrow('does not match');
  });

  it('rejects an attachment declared above the four megabyte limit', () => {
    expect(() =>
      validateInboundImageBytes({
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        declaredMimeType: 'image/jpeg',
        declaredSize: 4 * 1024 * 1024 + 1,
      })
    ).toThrow('4MB');
  });
});

describe('support inbound processing', () => {
  it('reopens a resolved ticket, stores the reply and attachment, and deduplicates retries', async () => {
    const address = buildSupportInboundReplyAddress({
      ticketId,
      domain,
      secret,
    });
    let ticket: InboundSupportTicket = {
      id: ticketId,
      email: 'member@example.com',
      message: '最初の問い合わせ',
      status: 'resolved',
      updated_at: '2026-07-25T11:00:00.000Z',
    };
    const loadAttachments = vi.fn(async () => [
      {
        name: 'error.png',
        url: 'https://storage.example.com/error.png',
        mimeType: 'image/png',
        size: 2048,
      },
    ]);
    const dependencies = createDependencies({
      ticket: () => ticket,
      email: createReceivedEmail({
        from: '会員 <member@example.com>',
        to: [address],
        text: 'まだエラーが出ます。\n\n> 過去の本文',
      }),
      loadAttachments,
      update: async (update) => {
        if (update.expectedUpdatedAt !== ticket.updated_at) return false;
        ticket = {
          ...ticket,
          message: update.message,
          status: update.status,
          updated_at: update.updatedAt,
        };
        return true;
      },
    });

    const first = await processSupportInboundEmail(
      {
        emailId: receivedEmailId,
        webhookId: 'msg_webhook_001',
        recipientAddresses: [address],
        domain,
        secret,
      },
      dependencies
    );
    const second = await processSupportInboundEmail(
      {
        emailId: receivedEmailId,
        webhookId: 'msg_webhook_retry',
        recipientAddresses: [address],
        domain,
        secret,
      },
      dependencies
    );

    expect(first).toEqual({
      outcome: 'processed',
      ticketId,
      receivedEmailId,
      attachmentCount: 1,
    });
    expect(second).toEqual({
      outcome: 'duplicate',
      ticketId,
      receivedEmailId,
    });
    expect(ticket.status).toBe('open');
    expect(ticket.message).toContain('まだエラーが出ます。');
    expect(ticket.message).toContain('error.png');
    expect(ticket.message.match(/種別: 顧客返信/g)).toHaveLength(1);
    expect(loadAttachments).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid recipient before retrieving any email content', async () => {
    const getReceivedEmail = vi.fn();
    const result = await processSupportInboundEmail(
      {
        emailId: receivedEmailId,
        webhookId: 'msg_webhook_002',
        recipientAddresses: ['support@example.com'],
        domain,
        secret,
      },
      {
        getReceivedEmail,
        getTicket: vi.fn(),
        updateTicket: vi.fn(),
        loadAttachments: vi.fn(),
      }
    );

    expect(result).toEqual({
      outcome: 'ignored',
      reason: 'invalid_recipient',
    });
    expect(getReceivedEmail).not.toHaveBeenCalled();
  });

  it('rejects a sender that differs from the authenticated ticket email', async () => {
    const address = buildSupportInboundReplyAddress({
      ticketId,
      domain,
      secret,
    });
    const updateTicket =
      vi.fn<SupportInboundDependencies['updateTicket']>();
    const result = await processSupportInboundEmail(
      {
        emailId: receivedEmailId,
        webhookId: 'msg_webhook_003',
        recipientAddresses: [address],
        domain,
        secret,
      },
      createDependencies({
        ticket: () => ({
          id: ticketId,
          email: 'member@example.com',
          message: '問い合わせ',
          status: 'resolved',
          updated_at: '2026-07-25T11:00:00.000Z',
        }),
        email: createReceivedEmail({
          from: 'attacker@example.net',
          to: [address],
        }),
        update: updateTicket,
      })
    );

    expect(result).toEqual({
      outcome: 'ignored',
      reason: 'sender_mismatch',
    });
    expect(updateTicket).not.toHaveBeenCalled();
  });

  it('retries a compare-and-swap conflict without duplicating the reply', async () => {
    const address = buildSupportInboundReplyAddress({
      ticketId,
      domain,
      secret,
    });
    let ticket: InboundSupportTicket = {
      id: ticketId,
      email: 'member@example.com',
      message: '問い合わせ',
      status: 'in_progress',
      updated_at: '2026-07-25T11:00:00.000Z',
    };
    let updateAttempts = 0;
    const result = await processSupportInboundEmail(
      {
        emailId: receivedEmailId,
        webhookId: 'msg_webhook_004',
        recipientAddresses: [address],
        domain,
        secret,
      },
      createDependencies({
        ticket: () => ticket,
        email: createReceivedEmail({
          from: 'member@example.com',
          to: [address],
        }),
        update: async (update) => {
          updateAttempts += 1;
          if (updateAttempts === 1) {
            ticket = {
              ...ticket,
              message: `${ticket.message}\n別の処理による更新`,
              updated_at: '2026-07-25T11:01:00.000Z',
            };
            return false;
          }
          ticket = {
            ...ticket,
            message: update.message,
            status: update.status,
            updated_at: update.updatedAt,
          };
          return true;
        },
      })
    );

    expect(result.outcome).toBe('processed');
    expect(updateAttempts).toBe(2);
    expect(ticket.message).toContain('別の処理による更新');
    expect(ticket.message.match(/種別: 顧客返信/g)).toHaveLength(1);
  });
});

function createReceivedEmail(
  overrides: Partial<ReceivedSupportEmail> & {
    from: string;
    to: string[];
  }
): ReceivedSupportEmail {
  return {
    id: receivedEmailId,
    from: overrides.from,
    to: overrides.to,
    receivedFor: overrides.receivedFor || overrides.to,
    subject: overrides.subject || 'Re: ACTIサポート',
    text: overrides.text === undefined ? '追加の確認をお願いします。' : overrides.text,
    html: overrides.html || null,
    createdAt: overrides.createdAt || '2026-07-25T12:00:00.000Z',
  };
}

function createDependencies(params: {
  ticket: () => InboundSupportTicket | null;
  email: ReceivedSupportEmail;
  update: SupportInboundDependencies['updateTicket'];
  loadAttachments?: SupportInboundDependencies['loadAttachments'];
}): SupportInboundDependencies {
  return {
    getReceivedEmail: async () => params.email,
    getTicket: async () => params.ticket(),
    updateTicket: params.update,
    loadAttachments: params.loadAttachments || (async () => []),
    now: () => new Date('2026-07-25T12:05:00.000Z'),
  };
}
