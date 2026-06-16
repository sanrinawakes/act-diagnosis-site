import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  appendAttachmentMarkdown,
  formatBytes,
  type StoredAttachment,
} from '@/lib/attachments';
import { uploadImageAttachments, validateImageFiles } from '@/lib/server-attachments';

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
    const {
      name,
      email,
      category,
      subject,
      message,
      user_id,
      attachments: attachmentFiles,
    } = await parseSupportRequest(request);

    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        { error: '必須項目を入力してください' },
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

    // Save to database
    const { data: ticket, error: insertError } = await supabase
      .from('support_tickets')
      .insert({
        user_id: user_id || null,
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

      const { error: updateError } = await supabase
        .from('support_tickets')
        .update({
          message: storedMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', ticket.id);

      if (updateError) {
        console.error('Failed to update support ticket attachments:', updateError);
        return NextResponse.json(
          { error: '添付画像の保存に失敗しました' },
          { status: 500 }
        );
      }
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
        const emailBody = `
新しいサポートチケットが届きました。

━━━━━━━━━━━━━━━━━━━━
チケットID: ${ticket.id}
カテゴリ: ${categoryLabel}
━━━━━━━━━━━━━━━━━━━━

■ 送信者情報
名前: ${name}
メール: ${email}

■ 件名
${subject}

■ 内容
${message}
${attachmentText}

━━━━━━━━━━━━━━━━━━━━
送信日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
管理画面: ${process.env.NEXT_PUBLIC_SITE_URL || 'https://act-diagnosis-site.vercel.app'}/admin/support
━━━━━━━━━━━━━━━━━━━━
`.trim();

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: `ACTI サポート <${SUPPORT_FROM_EMAIL}>`,
            to: SUPPORT_NOTIFICATION_EMAILS,
            subject: `[ACTI サポート] ${categoryLabel}: ${subject}`,
            text: emailBody,
          }),
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

    return NextResponse.json({
      success: true,
      ticket_id: ticket.id,
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
  user_id: string | null;
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
      user_id: getFormString(formData, 'user_id').trim() || null,
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
    user_id: typeof body.user_id === 'string' && body.user_id.trim() ? body.user_id.trim() : null,
    attachments: [],
  };
}

function getFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
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
