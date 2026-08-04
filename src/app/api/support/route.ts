import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  appendAttachmentMarkdown,
  formatBytes,
  type StoredAttachment,
} from '@/lib/attachments';
import { uploadImageAttachments, validateImageFiles } from '@/lib/server-attachments';
import { createServerClient as createAuthenticatedClient } from '@/lib/supabase-server';
import {
  appendSupportTechnicalContext,
  normalizeSupportTechnicalContext,
} from '@/lib/support-ticket-context';
import {
  buildSupportEmailIdempotencyKey,
  deliverSupportReply,
} from '@/lib/server/support-email';
import { buildSupportReceiptMessage } from '@/lib/support-receipt';
import { buildSupportNotificationEmail } from '@/lib/support-notification';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DEFAULT_SUPPORT_NOTIFICATION_EMAIL = 'silversense.fzco@gmail.com';
const DEFAULT_SUPPORT_NOTIFICATION_CC_EMAILS = ['awakes2025@gmail.com'];
const SUPPORT_NOTIFICATION_EMAILS = getSupportNotificationEmails();
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Resend's onboarding@resend.dev sender is testing-only and fails for external recipients.
// Use the same verified sender domain as welcome/deactivation emails.
const SUPPORT_FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@silversense.cc';

export async function POST(request: NextRequest) {
  try {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const {
      name,
      email: requestedEmail,
      category,
      subject,
      message,
      source,
      session_id,
      page_path,
      attachments: attachmentFiles,
    } = await parseSupportRequest(request);

    if (!name || !requestedEmail || !subject || !message) {
      return NextResponse.json(
        { error: '必須項目を入力してください' },
        { status: 400 }
      );
    }
    if (
      name.length > 100 ||
      subject.length > 200 ||
      message.length > 10_000
    ) {
      return NextResponse.json(
        { error: '入力内容が長すぎます' },
        { status: 400 }
      );
    }

    try {
      validateImageFiles(attachmentFiles);
    } catch (validationError) {
      return NextResponse.json(
        {
          error:
            validationError instanceof Error
              ? validationError.message
              : '添付画像を確認してください',
        },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const authenticatedUser = await getAuthenticatedUser();
    if (!authenticatedUser?.id || !authenticatedUser.email) {
      return NextResponse.json(
        { error: 'ログインが必要です' },
        { status: 401 }
      );
    }
    const authenticatedUserId = authenticatedUser.id;
    const email = authenticatedUser.email;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentTicketCount, error: countError } = await supabase
      .from('support_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', authenticatedUserId)
      .gte('created_at', oneHourAgo);

    if (countError) throw countError;
    if ((recentTicketCount || 0) >= 5) {
      return NextResponse.json(
        {
          error:
            '短時間に複数のお問い合わせを受け付けています。少し時間をおいてからお試しください。',
        },
        { status: 429 }
      );
    }

    // Save to database
    const { data: ticket, error: insertError } = await supabase
      .from('support_tickets')
      .insert({
        user_id: authenticatedUserId,
        name,
        email,
        category: category || 'general',
        subject,
        message,
        status: 'open',
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to save support ticket:', insertError);
      return NextResponse.json(
        { error: 'サポートチケットの保存に失敗しました' },
        { status: 500 }
      );
    }

    let storedMessage = message;
    let uploadedAttachments: StoredAttachment[] = [];

    if (attachmentFiles.length > 0) {
      uploadedAttachments = await uploadImageAttachments({
        files: attachmentFiles,
        folder: `support/${ticket.id}`,
        supabaseUrl,
        serviceRoleKey: supabaseServiceRoleKey,
      });
      storedMessage = appendAttachmentMarkdown(message, uploadedAttachments);
    }

    const technicalContext = normalizeSupportTechnicalContext({
      source,
      sessionId: session_id,
      pagePath: page_path,
      userAgent: request.headers.get('user-agent'),
      deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA,
      reportedAt: new Date().toISOString(),
    });
    storedMessage = appendSupportTechnicalContext(
      storedMessage,
      technicalContext
    );

    const { error: updateError } = await supabase
      .from('support_tickets')
      .update({
        message: storedMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', ticket.id);

    if (updateError) {
      console.error('Failed to update support ticket details:', updateError);
      return NextResponse.json(
        { error: 'お問い合わせ情報の保存に失敗しました' },
        { status: 500 }
      );
    }

    // Send email notification via Resend (if email settings are configured)
    if (RESEND_API_KEY && SUPPORT_NOTIFICATION_EMAILS.length > 0) {
      try {
        if (!process.env.SUPPORT_NOTIFICATION_EMAIL) {
          console.log(
            `SUPPORT_NOTIFICATION_EMAIL not configured - using default ${DEFAULT_SUPPORT_NOTIFICATION_EMAIL}`
          );
        }

        const categoryLabel = getCategoryLabel(category);
        const attachmentText = uploadedAttachments.length
          ? [
              '',
              '■ 添付画像',
              ...uploadedAttachments.map(
                (attachment, index) =>
                  `${index + 1}. ${attachment.name} (${formatBytes(attachment.size)})`,
              ),
              ...uploadedAttachments.map((attachment) => attachment.url),
              '',
            ].join('\n')
          : '';
        const notificationEmail = buildSupportNotificationEmail({
          ticketId: ticket.id,
          categoryLabel,
          name,
          email,
          subject,
          message,
          attachmentText,
          technicalContext,
          sentAt: new Date().toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
          }),
          adminUrl: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://act-diagnosis-site.vercel.app'}/admin/support`,
        });

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Idempotency-Key': `support-notification-${ticket.id}`,
          },
          body: JSON.stringify({
            from: `ACTI サポート <${SUPPORT_FROM_EMAIL}>`,
            to: SUPPORT_NOTIFICATION_EMAILS,
            subject: notificationEmail.subject,
            text: notificationEmail.text,
          }),
          signal: AbortSignal.timeout(8000),
        });

        if (!emailResponse.ok) {
          const errorBody = await emailResponse.text();
          console.error('Failed to send notification email:', {
            status: emailResponse.status,
            statusText: emailResponse.statusText,
            body: errorBody,
          });
        }
      } catch (emailError) {
        // Email failure should not block the ticket creation
        console.error('Failed to send notification email:', emailError);
      }
    } else if (!RESEND_API_KEY) {
      console.log('RESEND_API_KEY not configured - skipping email notification');
    } else {
      console.error('Support notification recipients not configured - skipping email notification');
    }

    let receiptSent = false;
    try {
      const receipt = await deliverSupportReply({
        adminClient: supabase,
        ticketId: ticket.id,
        subject: `【ACTI】お問い合わせを受け付けました`,
        message: buildSupportReceiptMessage({
          name,
          ticketId: ticket.id,
        }),
        senderLabel: 'ACTI自動受付',
        idempotencyKey: buildSupportEmailIdempotencyKey({
          ticketId: ticket.id,
          purpose: 'receipt',
        }),
        statusOnSuccess: 'open',
      });
      receiptSent = receipt.success;
    } catch (receiptError) {
      console.error('Failed to send support receipt:', receiptError);
    }

    return NextResponse.json({
      success: true,
      ticket_id: ticket.id,
      receipt_sent: receiptSent,
    });
  } catch (error) {
    console.error('Support API error:', error);
    return NextResponse.json(
      { error: 'サーバーエラーが発生しました' },
      { status: 500 }
    );
  }
}

function getSupportNotificationEmails(): string[] {
  const primaryEmails = process.env.SUPPORT_NOTIFICATION_EMAIL || DEFAULT_SUPPORT_NOTIFICATION_EMAIL;
  const ccEmails =
    process.env.SUPPORT_NOTIFICATION_CC_EMAILS || DEFAULT_SUPPORT_NOTIFICATION_CC_EMAILS.join(',');

  return Array.from(
    new Set(
      `${primaryEmails},${ccEmails}`
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

type ParsedSupportRequest = {
  name: string;
  email: string;
  category: string;
  subject: string;
  message: string;
  source: string;
  session_id: string;
  page_path: string;
  attachments: File[];
};

async function parseSupportRequest(request: NextRequest): Promise<ParsedSupportRequest> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();

    return {
      name: getFormString(formData, 'name').trim(),
      email: getFormString(formData, 'email').trim(),
      category: getFormString(formData, 'category').trim() || 'general',
      subject: getFormString(formData, 'subject').trim(),
      message: getFormString(formData, 'message').trim(),
      source: getFormString(formData, 'source').trim() || 'support',
      session_id: getFormString(formData, 'session_id').trim(),
      page_path: getFormString(formData, 'page_path').trim(),
      attachments: formData
        .getAll('attachments')
        .filter((entry): entry is File => entry instanceof File && entry.size > 0),
    };
  }

  const body = await request.json();

  return {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    email: typeof body.email === 'string' ? body.email.trim() : '',
    category: typeof body.category === 'string' ? body.category.trim() : 'general',
    subject: typeof body.subject === 'string' ? body.subject.trim() : '',
    message: typeof body.message === 'string' ? body.message.trim() : '',
    source: typeof body.source === 'string' ? body.source.trim() : 'support',
    session_id: typeof body.session_id === 'string' ? body.session_id.trim() : '',
    page_path: typeof body.page_path === 'string' ? body.page_path.trim() : '',
    attachments: [],
  };
}

function getFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

async function getAuthenticatedUser() {
  try {
    const authClient = await createAuthenticatedClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    return user
      ? {
          id: user.id,
          email: user.email || '',
        }
      : null;
  } catch (error) {
    console.error('Failed to resolve support requester identity:', error);
    return null;
  }
}

function isAllowedOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  const allowedOrigins = new Set([request.nextUrl.origin]);
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (configuredSiteUrl) {
    try {
      allowedOrigins.add(new URL(configuredSiteUrl).origin);
    } catch {
      // Ignore malformed optional configuration.
    }
  }

  return allowedOrigins.has(origin);
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    general: '一般的な質問',
    account: 'アカウントについて',
    billing: 'お支払いについて',
    bug: '不具合の報告',
    feature: '機能リクエスト',
    other: 'その他',
  };
  return labels[category] || category;
}
