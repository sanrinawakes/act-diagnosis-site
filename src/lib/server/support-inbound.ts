import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { Resend, type AttachmentData } from 'resend';
import {
  ATTACHMENT_BUCKET,
  fileExtensionFromMimeType,
  isAllowedImageType,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  sanitizeFileName,
  SIGNED_URL_EXPIRES_IN,
  type StoredAttachment,
} from '@/lib/attachments';
import { validateInboundImageBytes } from '@/lib/support-inbound';
import type {
  InboundSupportTicket,
  SupportInboundDependencies,
} from '@/lib/support-inbound-processor';
import { ensureAttachmentBucket } from '@/lib/server-attachments';

const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 12_000;

export function createSupportInboundDependencies(params: {
  adminClient: SupabaseClient;
  resend: Resend;
  fetchImpl?: typeof fetch;
}): SupportInboundDependencies {
  const fetchImpl = params.fetchImpl || fetch;

  return {
    async getReceivedEmail(emailId) {
      const { data, error } = await params.resend.emails.receiving.get(emailId, {
        html_format: 'cid',
      });
      if (error || !data) {
        throw new Error(
          `Received email lookup failed: ${error?.message || 'missing response'}`
        );
      }

      return {
        id: data.id,
        from: data.from,
        to: data.to || [],
        receivedFor: data.received_for || [],
        subject: data.subject || '',
        text: data.text,
        html: data.html,
        createdAt: data.created_at,
      };
    },

    async getTicket(ticketId) {
      const { data, error } = await params.adminClient
        .from('support_tickets')
        .select('id,email,message,status,updated_at')
        .eq('id', ticketId)
        .maybeSingle<InboundSupportTicket>();
      if (error) throw error;
      return data || null;
    },

    async updateTicket(update) {
      const { data, error } = await params.adminClient
        .from('support_tickets')
        .update({
          message: update.message,
          status: update.status,
          updated_at: update.updatedAt,
        })
        .eq('id', update.ticketId)
        .eq('updated_at', update.expectedUpdatedAt)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },

    async loadAttachments({ receivedEmailId, ticketId }) {
      const { data, error } =
        await params.resend.emails.receiving.attachments.list({
          emailId: receivedEmailId,
          limit: 100,
        });
      if (error) {
        throw new Error(`Inbound attachment lookup failed: ${error.message}`);
      }

      const candidates = (data?.data || [])
        .filter(isAcceptedAttachmentMetadata)
        .slice(0, MAX_IMAGE_ATTACHMENTS);
      if (candidates.length === 0) return [];

      await ensureAttachmentBucket(params.adminClient);
      return Promise.all(
        candidates.map((attachment) =>
          storeInboundAttachment({
            attachment,
            receivedEmailId,
            ticketId,
            adminClient: params.adminClient,
            fetchImpl,
          })
        )
      );
    },
  };
}

async function storeInboundAttachment(params: {
  attachment: AttachmentData;
  receivedEmailId: string;
  ticketId: string;
  adminClient: SupabaseClient;
  fetchImpl: typeof fetch;
}): Promise<StoredAttachment> {
  const downloadUrl = new URL(params.attachment.download_url);
  if (downloadUrl.protocol !== 'https:') {
    throw new Error('Inbound attachment download URL must use HTTPS');
  }

  const response = await params.fetchImpl(downloadUrl, {
    signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      `Inbound attachment download failed with HTTP ${response.status}`
    );
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const detectedMimeType = validateInboundImageBytes({
    bytes,
    declaredMimeType: params.attachment.content_type,
    declaredSize: Math.max(params.attachment.size, declaredLength),
  });

  const safeName = sanitizeFileName(
    params.attachment.filename || `attachment-${params.attachment.id}`
  );
  const baseName = safeName.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const extension = fileExtensionFromMimeType(detectedMimeType);
  const safeAttachmentId = params.attachment.id.replace(
    /[^A-Za-z0-9_-]/g,
    '-'
  );
  const safeEmailId = params.receivedEmailId.replace(
    /[^A-Za-z0-9_-]/g,
    '-'
  );
  const path = `support/${params.ticketId}/inbound/${safeEmailId}/${safeAttachmentId}-${baseName}.${extension}`;

  const { error: uploadError } = await params.adminClient.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, Buffer.from(bytes), {
      contentType: detectedMimeType,
      cacheControl: '31536000',
      upsert: true,
    });
  if (uploadError) {
    throw new Error(`Inbound attachment storage failed: ${uploadError.message}`);
  }

  const { data: signedData, error: signedError } =
    await params.adminClient.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(path, SIGNED_URL_EXPIRES_IN);
  if (signedError || !signedData?.signedUrl) {
    throw new Error(
      `Inbound attachment URL creation failed: ${signedError?.message || 'unknown error'}`
    );
  }

  return {
    name: safeName,
    url: signedData.signedUrl,
    path,
    mimeType: detectedMimeType,
    size: bytes.byteLength,
  };
}

function isAcceptedAttachmentMetadata(attachment: AttachmentData) {
  return (
    attachment.size > 0 &&
    attachment.size <= MAX_IMAGE_BYTES &&
    isAllowedImageType(normalizeImageMimeType(attachment.content_type))
  );
}

function normalizeImageMimeType(value: string) {
  return value.trim().toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : value.trim().toLowerCase();
}
