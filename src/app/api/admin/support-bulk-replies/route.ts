import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ReplyTarget = {
  id: string;
  name: string;
  email: string;
  subject: string;
  body: string;
  ticketIds: string[];
};

const REPLY_TO_EMAIL = 'silversense.fzco@gmail.com';
const SEND_CONFIRMATION = 'send-20260616-support-replies';
const TEST_TICKET_IDS = ['c196f970-a4e6-45f9-8d0f-8ae663340052'];
const SEND_INTERVAL_MS = 350;
const RATE_LIMIT_RETRY_MS = 1500;

const replyTargets: ReplyTarget[] = [
  {
    id: 'oogoda',
    name: '大胡田様',
    email: 'a.oogoda@gmail.com',
    subject: 'ACTIコーチング不具合の件',
    body: `大胡田様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

ACTIコーチングで「応答に失敗しました」と表示される不具合について、原因箇所を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度AIコーチングをお試しください。

再度同じ症状が出る場合は、表示された画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: ['f162ae70-a187-4e81-8f37-f18dc1f796b4'],
  },
  {
    id: 'kawahara',
    name: '川原様',
    email: 'sakusakubloom.9@gmail.com',
    subject: 'ACTIコーチング不具合の件',
    body: `川原様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

ACTIコーチングで「応答に失敗しました」と表示される不具合について、原因箇所を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度AIコーチングをお試しください。

再度同じ症状が出る場合は、表示された画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: ['05e32d64-f4bb-4992-b39a-409144ac2bf8'],
  },
  {
    id: 'kubota',
    name: '久保田様',
    email: 'kumu1875k@gmail.com',
    subject: 'ACTIコーチング不具合の件',
    body: `久保田様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

ACTIコーチングで、応答が返らない・通信が途切れる・相談が途中で止まる件について、原因箇所を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度AIコーチングをお試しください。

なお、以前のChatGPT版での会話内容がACTIに完全に引き継がれていない点については、現状の仕様上、すべての過去会話を自動反映することができておりません。ご不便をおかけし申し訳ございません。

再度同じ症状が出る場合は、表示された画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: [
      '35f46288-7490-4ff1-a06d-9fb4fd6739bb',
      '32a4190a-c2fa-40c3-9b27-b91b204ea758',
      '30a746c7-900b-4d06-81c8-4ad8542a9837',
      '146bdbf4-e1e5-494f-b835-338afe42d545',
    ],
  },
  {
    id: 'hattori',
    name: '服部様',
    email: 'yusaku.h.1107@gmail.com',
    subject: 'ACTIコーチング不具合の件',
    body: `服部様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

ACTIコーチングで「応答に失敗しました」と表示される不具合について、原因箇所を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度AIコーチングをお試しください。

再度同じ症状が出る場合は、表示された画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: ['2683d98f-dd0b-47ce-8e66-246e8a360ec9'],
  },
  {
    id: 'nakamura',
    name: '中村様',
    email: 'phantommasumi@gmail.com',
    subject: 'ACTIコーチング不具合とご要望の件',
    body: `中村様

複数回ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

ACTIコーチングで、送信中のまま止まる・返信が返ってこない・履歴が開けない／残らない件について、原因箇所を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度AIコーチングをお試しください。

なお、画像やスクリーンショットをAIに送る機能については、現時点では未対応です。ご要望として受け取り、今後の改善項目として検討いたします。

再度同じ症状が出る場合は、表示された画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: [
      'acf0a3a8-b518-414d-a6bf-c96614c03b6a',
      'c278d566-29d9-49fa-acf4-16eb43502502',
      '7f64695a-8657-4894-80c3-2b2d6bd8ed31',
      'fb88c6b1-01ff-4b26-b6a0-a309a637c288',
    ],
  },
  {
    id: 'aizawa',
    name: '会沢様',
    email: 'akihiro.aizawa.s.491001.a.a@gmail.com',
    subject: 'ACTIコーチング不具合の件',
    body: `会沢様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

AIボット診断中にフリーズし、回答が途中で止まってしまう件について、関連する応答処理の不具合を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度お試しください。

再度同じ症状が出る場合は、表示された画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: ['382f2cb0-f618-4ad6-9e08-6fd455d93598'],
  },
  {
    id: 'sato',
    name: '佐藤様',
    email: 'peachflower87@gmail.com',
    subject: 'ACTIコーチングへの移行について',
    body: `佐藤様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

以前ご利用いただいていたChatGPT版のコーチングBotについては、現在ACTIサイト側での利用へ移行しております。

お手数ですが、ACTIサイトにログインのうえ、AIコーチングをご利用ください。
なお、ChatGPT版での過去の会話内容をACTI側へ完全に自動引き継ぎすることは、現状できておりません。ご不便をおかけし申し訳ございません。

ACTI側でログインや利用ができない場合は、表示画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: ['035fe540-9090-4744-af4b-a2e363d0d6eb'],
  },
  {
    id: 'kawamoto',
    name: '川本様',
    email: 'kykorenotaan1321@gmail.com',
    subject: 'ACTIアカウント有効化状況のご確認',
    body: `川本様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

現在のアカウント状態を確認したところ、ご登録メールアドレスはACTI上で有料会員として有効化されています。

お手数ですが、同じメールアドレスでログインし直していただき、AIコーチングをご確認ください。

まだ無料会員表示になる場合は、ログイン中のメールアドレスが分かる画面、または表示画面のスクリーンショットをお送りください。すぐ確認いたします。

ACTIサポート`,
    ticketIds: ['a410352d-514b-45b1-8386-deb70bcccfd6'],
  },
  {
    id: 'takikawa',
    name: '瀧川様',
    email: 'kouki.takikawa@gmail.com',
    subject: 'ACTIコーチングのご利用と入力欄修正について',
    body: `瀧川様

複数件ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

ChatGPTアプリ側のACT診断コーチについては、現在ACTIサイト側での利用へ移行しております。お手数ですが、ACTIサイトにログインのうえAIコーチングをご利用ください。

また、メッセージ入力欄で改行ができない件については修正を反映いたしました。ページを再読み込み後、入力欄で改行できるかご確認ください。

画像添付機能については、現時点では未対応です。ご要望として受け取り、今後の改善項目として検討いたします。

ACTIサポート`,
    ticketIds: [
      '2b4a2c6d-c1dc-4915-bfa4-bb22b833cd19',
      '18e438df-c766-41ae-a660-362adc8f46f7',
      'a462f408-e535-49a0-aeb3-a71443a52453',
    ],
  },
  {
    id: 'yamagami',
    name: '山上様',
    email: 'm.ranchan.015067a8k@gmail.com',
    subject: 'ACTIコーチングへの移行について',
    body: `山上様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

以前ご利用いただいていたChatGPT側のACT診断コーチについては、現在ACTIサイト側での利用へ移行しております。

お手数ですが、ACTIサイトにログインのうえ、AIコーチングをご利用ください。

ACTI側でログインや利用ができない場合は、表示画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: ['1d7b86ca-df97-4f0a-b1e5-9e16de6ff6c2'],
  },
  {
    id: 'kasahara',
    name: '笠原様',
    email: '9stmidori@gmail.com',
    subject: 'ACTIアカウント有効化状況のご確認',
    body: `笠原様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

現在のアカウント状態を確認したところ、ご登録メールアドレスはACTI上で有料会員として有効化されています。

お手数ですが、同じメールアドレスでログインし直していただき、AIコーチングをご確認ください。

まだ無料会員表示になる場合は、ログイン中のメールアドレスが分かる画面、または表示画面のスクリーンショットをお送りください。すぐ確認いたします。

ACTIサポート`,
    ticketIds: [
      '9b8935a7-0c51-4845-b62e-fd336d5ef753',
      '3b87b14e-f9fb-4729-a3d2-252c1cb46b1d',
    ],
  },
  {
    id: 'yamaguchi',
    name: '山口様',
    email: 'yamarika.0320@gmail.com',
    subject: 'ACTIアカウント有効化状況のご確認',
    body: `山口様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

現在のアカウント状態を確認したところ、ご登録メールアドレスはACTI上で有料会員として有効化されています。

お手数ですが、同じメールアドレスでログインし直していただき、AIコーチングをご確認ください。

まだ無料会員表示になる場合は、ログイン中のメールアドレスが分かる画面、または表示画面のスクリーンショットをお送りください。すぐ確認いたします。

ACTIサポート`,
    ticketIds: ['d09b5932-3723-47bb-b76e-5e37bcc69272'],
  },
  {
    id: 'hamada',
    name: '浜田様',
    email: 'shanti726@gmail.com',
    subject: 'ACTIチャット・診断表示の件',
    body: `浜田様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

チャットボットの回答が遅い、再読み込みしないと回答が得られない件について、関連する応答処理の不具合を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度お試しください。

また、診断で選択したものと違うものが反映される件については、もし現在も同じ症状が出る場合、どの設問でどの選択肢を選んだかが分かるスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート`,
    ticketIds: [
      '53847fed-dd43-4119-aa2b-bebc539a37a5',
      '6998ba0c-323a-4c6c-a051-6fc33404e5f9',
    ],
  },
];

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function sendReply(target: ReplyTarget, fromEmail: string, resendApiKey: string) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
      'Idempotency-Key': `acti-support-reply-20260616-${target.id}`,
    },
    body: JSON.stringify({
      from: `ACTI サポート <${fromEmail}>`,
      to: [target.email],
      reply_to: REPLY_TO_EMAIL,
      subject: target.subject,
      text: target.body,
    }),
  });

  const body = await response.text();
  let parsedBody: unknown = body;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    // Keep the raw body for diagnostics.
  }

  return {
    id: target.id,
    name: target.name,
    email: target.email,
    ticketIds: target.ticketIds,
    ok: response.ok,
    status: response.status,
    response: parsedBody,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  try {
    const sendSecret = request.headers.get('x-send-secret');
    const sendConfirmation = request.headers.get('x-send-confirmation');

    if (!process.env.MYASP_WEBHOOK_SECRET || sendSecret !== process.env.MYASP_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (sendConfirmation !== SEND_CONFIRMATION) {
      return NextResponse.json({ error: 'Confirmation header mismatch' }, { status: 400 });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      return NextResponse.json({ error: 'RESEND_API_KEY is not configured' }, { status: 500 });
    }

    const fromEmail = process.env.FROM_EMAIL || 'noreply@silversense.cc';
    const adminClient = createAdminClient();

    const targetTicketIds = replyTargets.flatMap((target) => target.ticketIds);
    const { data: existingTickets, error: existingTicketsError } = await adminClient
      .from('support_tickets')
      .select('id, status')
      .in('id', targetTicketIds);

    if (existingTicketsError) {
      return NextResponse.json(
        { error: 'Failed to load ticket statuses', details: existingTicketsError },
        { status: 500 }
      );
    }

    const ticketStatusById = new Map(
      (existingTickets || []).map((ticket) => [ticket.id, ticket.status])
    );
    const pendingTargets = replyTargets.filter((target) =>
      target.ticketIds.some((ticketId) => ticketStatusById.get(ticketId) === 'open')
    );

    const sendResults = [];
    for (const [index, target] of pendingTargets.entries()) {
      if (index > 0) {
        await sleep(SEND_INTERVAL_MS);
      }

      let result = await sendReply(target, fromEmail, resendApiKey);

      if (!result.ok && result.status === 429) {
        await sleep(RATE_LIMIT_RETRY_MS);
        result = await sendReply(target, fromEmail, resendApiKey);
      }

      sendResults.push(result);
    }

    const successfulTicketIds = sendResults
      .filter((result) => result.ok)
      .flatMap((result) => result.ticketIds);

    const now = new Date().toISOString();
    const statusUpdates: Record<string, unknown> = {};

    if (successfulTicketIds.length > 0) {
      const { data, error } = await adminClient
        .from('support_tickets')
        .update({ status: 'in_progress', updated_at: now })
        .in('id', successfulTicketIds)
        .select('id, email, status, updated_at');

      statusUpdates.customerTickets = { data, error };
    }

    const { data: testTicketData, error: testTicketError } = await adminClient
      .from('support_tickets')
      .update({ status: 'resolved', updated_at: now })
      .in('id', TEST_TICKET_IDS)
      .select('id, email, status, updated_at');

    statusUpdates.testTickets = { data: testTicketData, error: testTicketError };

    const allTicketIds = [...successfulTicketIds, ...TEST_TICKET_IDS];
    const { data: verificationRows, error: verificationError } = await adminClient
      .from('support_tickets')
      .select('id, email, status, updated_at')
      .in('id', allTicketIds)
      .order('updated_at', { ascending: false });

    const failedSends = sendResults.filter((result) => !result.ok);
    const dbErrors = [
      statusUpdates.customerTickets &&
        typeof statusUpdates.customerTickets === 'object' &&
        'error' in statusUpdates.customerTickets
        ? statusUpdates.customerTickets.error
        : null,
      testTicketError,
      verificationError,
    ].filter(Boolean);
    const status = failedSends.length > 0 || dbErrors.length > 0 ? 207 : 200;

    return NextResponse.json(
      {
        sentAt: now,
        from: `ACTI サポート <${fromEmail}>`,
        replyTo: REPLY_TO_EMAIL,
        requestedRecipients: replyTargets.length,
        pendingRecipients: pendingTargets.length,
        skippedRecipients: replyTargets.length - pendingTargets.length,
        sentRecipients: sendResults.filter((result) => result.ok).length,
        failedRecipients: failedSends.length,
        dbErrorCount: dbErrors.length,
        sendResults,
        updatedCustomerTicketCount: successfulTicketIds.length,
        testTicketIds: TEST_TICKET_IDS,
        statusUpdates,
        verification: {
          count: verificationRows?.length || 0,
          rows: verificationRows,
          error: verificationError,
        },
      },
      { status }
    );
  } catch (error) {
    console.error('Support bulk replies failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
