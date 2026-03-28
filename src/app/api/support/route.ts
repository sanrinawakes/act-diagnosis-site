import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPPORT_NOTIFICATION_EMAIL = process.env.SUPPORT_NOTIFICATION_EMAIL || 'support@example.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, email, category, subject, message, user_id } = body;

    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        { error: '必須項目を入力してください' },
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

    // Send email notification via Resend (if API key is configured)
    if (RESEND_API_KEY) {
      try {
        const categoryLabel = getCategoryLabel(category);
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

━━━━━━━━━━━━━━━━━━━━
送信日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
管理画面: ${process.env.NEXT_PUBLIC_SITE_URL || 'https://act-diagnosis-site.vercel.app'}/admin/support
━━━━━━━━━━━━━━━━━━━━
`.trim();

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: 'ACTI サポート <onboarding@resend.dev>',
            to: [SUPPORT_NOTIFICATION_EMAIL],
            subject: `[ACTI サポート] ${categoryLabel}: ${subject}`,
            text: emailBody,
          }),
        });
      } catch (emailError) {
        // Email failure should not block the ticket creation
        console.error('Failed to send notification email:', emailError);
      }
    } else {
      console.log('RESEND_API_KEY not configured - skipping email notification');
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
