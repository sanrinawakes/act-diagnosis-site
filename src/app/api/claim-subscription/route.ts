import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  createSubscriptionClaimCode,
  getSubscriptionClaimExpiry,
  hashSubscriptionClaimCode,
  isSubscriptionClaimEmail,
  normalizeSubscriptionClaimEmail,
  SUBSCRIPTION_CLAIM_MAX_ATTEMPTS,
} from '@/lib/subscription-claim';
import { hasActiveAwakesAccess } from '@/lib/coaching-access';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const claimSecret = process.env.SUBSCRIPTION_CLAIM_SECRET || '';
const resendApiKey = process.env.RESEND_API_KEY || '';
const fromEmail = process.env.FROM_EMAIL || 'noreply@silversense.cc';

type ClaimRequest = {
  action?: unknown;
  email?: unknown;
  code?: unknown;
};

function createAdminClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: '認証されていません' }, { status: 401 });
    }

    const body = (await request.json()) as ClaimRequest;
    const action = body.action;
    const awakesEmail = normalizeSubscriptionClaimEmail(body.email);
    if (!isSubscriptionClaimEmail(awakesEmail)) {
      return NextResponse.json(
        { error: '有効なメールアドレスを入力してください' },
        { status: 400 }
      );
    }

    if (action === 'request_code') {
      return await requestClaimCode({ userId: user.id, awakesEmail });
    }
    if (action === 'verify_code') {
      return await verifyClaimCode({
        userId: user.id,
        awakesEmail,
        code: typeof body.code === 'string' ? body.code.trim() : '',
      });
    }

    return NextResponse.json(
      { error: '確認コードを送信してから入力してください' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Subscription claim request failed:', error);
    return NextResponse.json(
      { error: '紐付けの処理に失敗しました。時間をおいて、もう一度お試しください。' },
      { status: 500 }
    );
  }
}

async function getAuthenticatedUser(request: NextRequest) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) return null;

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function requestClaimCode(params: { userId: string; awakesEmail: string }) {
  if (!claimSecret || !resendApiKey) {
    console.error('Subscription claim delivery is not configured', {
      claimSecretConfigured: Boolean(claimSecret),
      resendConfigured: Boolean(resendApiKey),
    });
    return NextResponse.json(
      { error: '確認コードを送信できません。時間をおいて、もう一度お試しください。' },
      { status: 503 }
    );
  }

  const admin = createAdminClient();
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('subscription_status, is_active, awakes_access_expires_at')
    .eq('id', params.userId)
    .maybeSingle();
  if (profileError || !profile) {
    console.error('Subscription claim profile lookup failed:', profileError);
    return NextResponse.json(
      { error: '紐付け情報を確認できません。時間をおいて、もう一度お試しください。' },
      { status: 503 }
    );
  }
  if (hasActiveAwakesAccess(profile)) {
    return NextResponse.json({
      success: true,
      status: 'already_active',
      message: 'このアカウントでは、すでに有料機能をご利用いただけます。',
    });
  }

  const { data: pending, error: pendingError } = await admin
    .from('pending_activations')
    .select('email, activated, access_expires_at')
    .eq('email', params.awakesEmail)
    .limit(1)
    .maybeSingle();
  if (pendingError) {
    console.error('Subscription claim payment lookup failed:', pendingError);
    return NextResponse.json(
      { error: '紐付け情報を確認できません。時間をおいて、もう一度お試しください。' },
      { status: 503 }
    );
  }

  // Do not disclose whether a payment record exists to the signed-in account.
  if (
    !pending ||
    pending.activated ||
    !pending.access_expires_at ||
    Date.parse(pending.access_expires_at) <= Date.now() ||
    profile.subscription_status === 'cancelled' ||
    profile.subscription_status === 'payment_failed'
  ) {
    return NextResponse.json({
      success: true,
      status: 'unavailable',
      message:
        '一致する会員情報を確認できた場合のみ、確認コードをそのメールアドレスへ送信します。数分待っても届かない場合は、登録メールアドレスをご確認ください。',
    });
  }

  const code = createSubscriptionClaimCode();
  const codeHash = hashSubscriptionClaimCode({
    secret: claimSecret,
    userId: params.userId,
    awakesEmail: params.awakesEmail,
    code,
  });
  const now = new Date().toISOString();
  const { error: challengeError } = await admin
    .from('subscription_claim_challenges')
    .upsert(
      {
        user_id: params.userId,
        awakes_email: params.awakesEmail,
        code_hash: codeHash,
        attempts: 0,
        expires_at: getSubscriptionClaimExpiry(),
        sent_at: now,
        consumed_at: null,
        updated_at: now,
      },
      { onConflict: 'user_id,awakes_email' }
    );
  if (challengeError) {
    console.error('Subscription claim challenge save failed:', challengeError);
    return NextResponse.json(
      { error: '確認コードを準備できません。時間をおいて、もう一度お試しください。' },
      { status: 503 }
    );
  }

  const delivered = await deliverClaimCode({ to: params.awakesEmail, code });
  if (!delivered) {
    await admin
      .from('subscription_claim_challenges')
      .delete()
      .eq('user_id', params.userId)
      .eq('awakes_email', params.awakesEmail)
      .eq('code_hash', codeHash);
    return NextResponse.json(
      { error: '確認コードを送信できません。時間をおいて、もう一度お試しください。' },
      { status: 503 }
    );
  }

  return NextResponse.json({
    success: true,
    status: 'code_sent',
    message:
      'AWAKESの登録メールアドレスへ確認コードを送信しました。メールに記載の6桁のコードを入力してください。',
  });
}

async function verifyClaimCode(params: {
  userId: string;
  awakesEmail: string;
  code: string;
}) {
  if (!claimSecret) {
    console.error('Subscription claim verification is not configured');
    return NextResponse.json(
      { error: '紐付けを確認できません。時間をおいて、もう一度お試しください。' },
      { status: 503 }
    );
  }
  if (!/^\d{6}$/.test(params.code)) {
    return NextResponse.json(
      { error: 'メールに記載された6桁の確認コードを入力してください。' },
      { status: 400 }
    );
  }

  const codeHash = hashSubscriptionClaimCode({
    secret: claimSecret,
    userId: params.userId,
    awakesEmail: params.awakesEmail,
    code: params.code,
  });
  const { data, error } = await createAdminClient().rpc(
    'consume_verified_subscription_claim',
    {
      p_user_id: params.userId,
      p_awakes_email: params.awakesEmail,
      p_code_hash: codeHash,
      p_max_attempts: SUBSCRIPTION_CLAIM_MAX_ATTEMPTS,
    }
  );
  if (error) {
    console.error('Subscription claim verification failed:', error);
    return NextResponse.json(
      { error: '紐付けを確認できません。時間をおいて、もう一度お試しください。' },
      { status: 503 }
    );
  }
  const result = Array.isArray(data) ? data[0] : data;
  const status = result && typeof result.status === 'string' ? result.status : '';
  if (status === 'claimed' || status === 'already_active') {
    return NextResponse.json({
      success: true,
      status,
      message: '有料会員情報を紐付けました。ページを更新してご利用ください。',
    });
  }
  if (status === 'invalid_code') {
    return NextResponse.json(
      { error: '確認コードが正しくありません。もう一度ご確認ください。' },
      { status: 400 }
    );
  }
  if (status === 'expired' || status === 'locked' || status === 'challenge_missing') {
    return NextResponse.json(
      { error: '確認コードの有効期限が切れたか、使用できません。もう一度コードを送信してください。' },
      { status: 400 }
    );
  }
  return NextResponse.json(
    { error: 'この会員情報では紐付けできません。登録情報をご確認ください。' },
    { status: 403 }
  );
}

async function deliverClaimCode(params: { to: string; code: string }) {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: `ACTI サポート <${fromEmail}>`,
        to: [params.to],
        subject: '【ACTI】有料会員情報の確認コード',
        text: `ACTIの有料会員情報を紐付けるための確認コードは ${params.code} です。\n\nこのコードは15分間有効です。心当たりがない場合は、このメールを破棄してください。`,
      }),
    });
    if (!response.ok) {
      console.error('Subscription claim code delivery failed:', {
        status: response.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error('Subscription claim code delivery failed:', error);
    return false;
  }
}
