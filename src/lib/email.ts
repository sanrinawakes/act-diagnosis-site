import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY;

let resend: Resend | null = null;
function getResend(): Resend {
  if (!resend) {
    if (!resendApiKey) {
      throw new Error('Missing RESEND_API_KEY environment variable');
    }
    resend = new Resend(resendApiKey);
  }
  return resend;
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@act-diagnosis-site.vercel.app';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://act-diagnosis-site.vercel.app';
const SITE_NAME = 'ACT診断 - Awakes';

/**
 * Send welcome email with login credentials to a new user
 */
export async function sendWelcomeEmail(params: {
  to: string;
  displayName: string;
  password: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const r = getResend();
    const loginUrl = `${SITE_URL}/login`;

    const { data, error } = await r.emails.send({
      from: `${SITE_NAME} <${FROM_EMAIL}>`,
      to: params.to,
      subject: `【ACT診断】Awakesメンバーサイトのアカウントが作成されました`,
      html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family: 'Helvetica Neue', Arial, sans-serif; line-height: 1.8; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">ACT診断 コーチングサイト</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0;">Awakes メンバー専用</p>
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    <p>${params.displayName} 様</p>

    <p>Awakesオンラインスクールの有料会員向けACT診断サイトのアカウントが作成されました。</p>

    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <h3 style="margin: 0 0 12px; color: #1d4ed8;">ログイン情報</h3>
      <table style="width: 100%;">
        <tr>
          <td style="padding: 4px 0; font-weight: bold; width: 120px;">メールアドレス:</td>
          <td style="padding: 4px 0;">${params.to}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-weight: bold;">パスワード:</td>
          <td style="padding: 4px 0; font-family: monospace; font-size: 16px; letter-spacing: 1px;">${params.password}</td>
        </tr>
      </table>
    </div>

    <div style="text-align: center; margin: 24px 0;">
      <a href="${loginUrl}" style="display: inline-block; background: #3b82f6; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: bold;">ログインする</a>
    </div>

    <p style="color: #6b7280; font-size: 14px;">ログイン後、マイページからパスワードを変更することをおすすめします。</p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">

    <p style="color: #9ca3af; font-size: 12px; text-align: center;">
      このメールはAwakesオンラインスクールの決済完了に伴い自動送信されています。<br>
      心当たりがない場合は、このメールを無視してください。
    </p>
  </div>
</body>
</html>`,
    });

    if (error) {
      console.error('Failed to send welcome email:', error);
      return { success: false, error: error.message };
    }

    console.log('Welcome email sent successfully:', data);
    return { success: true };
  } catch (err) {
    console.error('Email sending error:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown email error',
    };
  }
}

/**
 * Send account deactivation notification email
 */
export async function sendDeactivationEmail(params: {
  to: string;
  displayName: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const r = getResend();

    const { data, error } = await r.emails.send({
      from: `${SITE_NAME} <${FROM_EMAIL}>`,
      to: params.to,
      subject: `【ACT診断】アカウントが無効化されました`,
      html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family: 'Helvetica Neue', Arial, sans-serif; line-height: 1.8; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #6b7280; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">ACT診断 コーチングサイト</h1>
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    <p>${params.displayName} 様</p>

    <p>Awakesオンラインスクールの会員ステータスの変更に伴い、ACT診断サイトへのアクセスが一時的に無効化されました。</p>

    <p>再度ご利用いただくには、Awakesオンラインスクールの有料会員を継続していただく必要があります。</p>

    <p>ご不明な点がございましたら、Awakesサポートまでお問い合わせください。</p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">

    <p style="color: #9ca3af; font-size: 12px; text-align: center;">
      このメールは自動送信されています。
    </p>
  </div>
</body>
</html>`,
    });

    if (error) {
      console.error('Failed to send deactivation email:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    console.error('Email sending error:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown email error',
    };
  }
}
