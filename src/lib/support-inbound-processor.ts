import type { StoredAttachment } from '@/lib/attachments';
import {
  appendSupportInboundLog,
  extractCustomerReplyText,
  hasSupportInboundEmail,
  normalizeMailboxAddress,
  parseSupportInboundReplyAddress,
} from '@/lib/support-inbound';

export type InboundSupportTicket = {
  id: string;
  email: string;
  message: string;
  status: string;
  updated_at: string;
};

export type ReceivedSupportEmail = {
  id: string;
  from: string;
  to: string[];
  receivedFor: string[];
  subject: string;
  text: string | null;
  html: string | null;
  createdAt: string;
};

export type SupportInboundDependencies = {
  getReceivedEmail: (emailId: string) => Promise<ReceivedSupportEmail>;
  getTicket: (ticketId: string) => Promise<InboundSupportTicket | null>;
  updateTicket: (params: {
    ticketId: string;
    expectedUpdatedAt: string;
    message: string;
    status: 'open';
    updatedAt: string;
  }) => Promise<boolean>;
  loadAttachments: (params: {
    receivedEmailId: string;
    ticketId: string;
  }) => Promise<StoredAttachment[]>;
  now?: () => Date;
};

export type ProcessSupportInboundParams = {
  emailId: string;
  webhookId: string;
  recipientAddresses: string[];
  domain: string;
  secret: string;
};

export type ProcessSupportInboundResult =
  | {
      outcome: 'processed';
      ticketId: string;
      receivedEmailId: string;
      attachmentCount: number;
    }
  | {
      outcome: 'duplicate';
      ticketId: string;
      receivedEmailId: string;
    }
  | {
      outcome: 'ignored';
      reason:
        | 'invalid_recipient'
        | 'recipient_mismatch'
        | 'ticket_not_found'
        | 'sender_mismatch';
    };

export async function processSupportInboundEmail(
  params: ProcessSupportInboundParams,
  dependencies: SupportInboundDependencies
): Promise<ProcessSupportInboundResult> {
  const eventRecipient = parseSupportInboundReplyAddress({
    addresses: params.recipientAddresses,
    domain: params.domain,
    secret: params.secret,
  });
  if (!eventRecipient) {
    return { outcome: 'ignored', reason: 'invalid_recipient' };
  }

  const receivedEmail = await dependencies.getReceivedEmail(params.emailId);
  const retrievedRecipient = parseSupportInboundReplyAddress({
    addresses: [...receivedEmail.receivedFor, ...receivedEmail.to],
    domain: params.domain,
    secret: params.secret,
  });
  if (
    !retrievedRecipient ||
    retrievedRecipient.ticketId !== eventRecipient.ticketId
  ) {
    return { outcome: 'ignored', reason: 'recipient_mismatch' };
  }

  let ticket = await dependencies.getTicket(eventRecipient.ticketId);
  if (!ticket) {
    return { outcome: 'ignored', reason: 'ticket_not_found' };
  }

  const senderEmail = normalizeMailboxAddress(receivedEmail.from);
  if (!senderEmail || senderEmail !== ticket.email.trim().toLowerCase()) {
    return { outcome: 'ignored', reason: 'sender_mismatch' };
  }
  if (hasSupportInboundEmail(ticket.message || '', receivedEmail.id)) {
    return {
      outcome: 'duplicate',
      ticketId: ticket.id,
      receivedEmailId: receivedEmail.id,
    };
  }

  const body = extractCustomerReplyText({
    text: receivedEmail.text,
    html: receivedEmail.html,
  });
  const attachments = await dependencies.loadAttachments({
    receivedEmailId: receivedEmail.id,
    ticketId: ticket.id,
  });
  const now = dependencies.now || (() => new Date());
  const receivedAt = isValidDate(receivedEmail.createdAt)
    ? new Date(receivedEmail.createdAt).toISOString()
    : now().toISOString();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (hasSupportInboundEmail(ticket.message || '', receivedEmail.id)) {
      return {
        outcome: 'duplicate',
        ticketId: ticket.id,
        receivedEmailId: receivedEmail.id,
      };
    }

    const updatedAt = now().toISOString();
    const updated = await dependencies.updateTicket({
      ticketId: ticket.id,
      expectedUpdatedAt: ticket.updated_at,
      message: appendSupportInboundLog(ticket.message || '', {
        receivedAt,
        senderEmail,
        toEmail: retrievedRecipient.address,
        subject: receivedEmail.subject.slice(0, 500),
        body,
        receivedEmailId: receivedEmail.id,
        webhookId: params.webhookId,
        attachments,
      }),
      status: 'open',
      updatedAt,
    });
    if (updated) {
      return {
        outcome: 'processed',
        ticketId: ticket.id,
        receivedEmailId: receivedEmail.id,
        attachmentCount: attachments.length,
      };
    }

    ticket = await dependencies.getTicket(eventRecipient.ticketId);
    if (!ticket) {
      return { outcome: 'ignored', reason: 'ticket_not_found' };
    }
    if (senderEmail !== ticket.email.trim().toLowerCase()) {
      return { outcome: 'ignored', reason: 'sender_mismatch' };
    }
  }

  throw new Error('Support ticket changed repeatedly while saving inbound email');
}

function isValidDate(value: string) {
  return Number.isFinite(new Date(value).getTime());
}
