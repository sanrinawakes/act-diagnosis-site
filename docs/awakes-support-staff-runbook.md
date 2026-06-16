# AWAKES/ACTI Support Staff Runbook

Last updated: 2026-06-16
Audience: AWAKES/ACTI support staff and Codex operators

## Overview

This runbook explains how staff should monitor ACTI support issues, respond to customers, and escalate technical problems without relying on Satoshi to manually check the admin screen.

The main support inbox is `awakes2025@gmail.com`. Satoshi's operational inbox is `181wyc@gmail.com`, and the restored notification fallback inbox is `silversense.fzco@gmail.com`.

## Current State As Of 2026-06-16

- Support ticket notifications now use the verified sender domain `noreply@silversense.cc`.
- Notifications are sent to `silversense.fzco@gmail.com` and copied to `awakes2025@gmail.com`.
- The old Resend sender `onboarding@resend.dev` caused external-send 403 errors and must not be used for production support notifications.
- The 2026-06-16 backlog was audited: 24 support tickets were found, 23 customer tickets were replied to, and 1 Codex test ticket was resolved.
- All audited affected customer profiles were active and `pending_activations` were already activated.
- The AI coaching failure path was patched before the backlog replies:
  - `src/app/api/chat/route.ts` has a longer function limit and Gemini timeout handling.
  - `src/app/coaching/page.tsx` has client timeout handling, saved fallback messages, and textarea input.
  - `src/data/coaching-system-prompt.ts` has prompt non-disclosure guardrails.

## Access Required

For ticket handling only, staff need:

- Gmail access to `awakes2025@gmail.com`.
- ACTI login access for `awakes2025@gmail.com`.
- ACTI admin access at `https://act-diagnosis-site.vercel.app/admin/support`.

For Codex-assisted technical work, staff also need:

- GitHub write access to `sanrinawakes/act-diagnosis-site`.
- Vercel access to project `act-diagnosis-site` under `sanrinawakes-projects`.
- Supabase access to project `yszqmhgicggyrnmcqlde`.
- Resend access for email logs and delivery failures.
- MyASP access for AWAKES member exports and webhook checks.
- Secrets through a secure password manager or private handoff, not through this repository.

Do not commit secrets, API keys, webhook secrets, exported customer CSVs, or private incident data into the public repository.

## Daily Support Workflow

1. Open `awakes2025@gmail.com`.
2. Search for subjects beginning with `[ACTI サポート]`.
3. Open the linked admin page: `https://act-diagnosis-site.vercel.app/admin/support`.
4. Filter by `未対応`.
5. For each ticket, record:
   - Customer name
   - Customer email
   - Subject
   - Exact error message or symptom
   - Date/time
   - Screenshot availability
6. Decide the category:
   - Account/access problem
   - AI coaching reply failure or slow response
   - Diagnosis/result mismatch
   - Feature request
   - Other
7. If responding immediately, set the ticket to `対応中`.
8. After the customer confirms resolution, set the ticket to `解決済み`.
9. If the issue is technical and not confirmed, leave it `対応中` until verified.

## Customer Reply Rules

- Apologize for the delay or inconvenience first.
- State what was checked or fixed.
- Ask the customer to reload, log out and log in again, or send a screenshot if the issue persists.
- Do not promise that all past ChatGPT conversations can be fully migrated into ACTI.
- Do not say a bug is fixed unless there is code, DB, log, or test evidence.

## Common Reply Templates

### AI Coaching Failure

Subject: `ACTIコーチング不具合の件`

```
〇〇様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

ACTIコーチングで「応答に失敗しました」と表示される不具合について、原因箇所を確認し、修正を反映いたしました。

お手数ですが、一度ページを再読み込み、またはログアウト→再ログインのうえ、再度AIコーチングをお試しください。

再度同じ症状が出る場合は、表示された画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート
```

### Account Shows Free User

Subject: `ACTIアカウント有効化状況のご確認`

```
〇〇様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

現在のアカウント状態を確認したところ、ご登録メールアドレスはACTI上で有料会員として有効化されています。

お手数ですが、同じメールアドレスでログインし直していただき、AIコーチングをご確認ください。

まだ無料会員表示になる場合は、ログイン中のメールアドレスが分かる画面、または表示画面のスクリーンショットをお送りください。すぐ確認いたします。

ACTIサポート
```

### ChatGPT Bot Migration

Subject: `ACTIコーチングへの移行について`

```
〇〇様

ご連絡いただいていたにもかかわらず、確認とご返信が遅くなり申し訳ございません。

以前ご利用いただいていたChatGPT版のコーチングBotについては、現在ACTIサイト側での利用へ移行しております。

お手数ですが、ACTIサイトにログインのうえ、AIコーチングをご利用ください。
なお、ChatGPT版での過去の会話内容をACTI側へ完全に自動引き継ぎすることは、現状できておりません。ご不便をおかけし申し訳ございません。

ACTI側でログインや利用ができない場合は、表示画面のスクリーンショットをお送りください。個別に確認いたします。

ACTIサポート
```

## Codex Operating Rules For Staff

Before asking Codex to change anything, tell it:

```
必ず /Users/sunsat/Documents/Claude/Projects/ACTI/AGENTS.md のルールを読んでから動いてください。
検証なしに「完了」と言わないでください。
```

For customer-impacting issues, ask Codex to produce evidence:

- DB state: exact profile/ticket/subscription rows.
- Code: exact file and behavior.
- Logs: Vercel, Supabase, or Resend evidence.
- Test result: exact request/response or browser verification.

Never accept a vague answer like:

- "たぶん直っています"
- "問題ないと思います"
- "完了です" without evidence

## Database Safety Rules

- Never bulk-update `subscription_status <> 'active'`.
- Never overwrite `subscription_status='cancelled'` in a bulk rescue.
- For bulk rescue, only target `subscription_status = 'none'` or `subscription_status is null`.
- Always confirm `profiles`, `pending_activations`, and AWAKES paid-member evidence before changing access.
- If using AWAKES/MyASP CSV, read it as CP932 and compare counts across encodings.

## AWAKES/MyASP CSV Rule

AWAKES exports often contain CP932-only characters. Before using a CSV, compare encodings:

```bash
file -i target.csv
wc -c target.csv
grep -c "@" target.csv

for enc in UTF-8 SHIFT_JIS CP932 EUC-JP UTF-16 UTF-16LE; do
  count=$(iconv -f $enc -t UTF-8 target.csv 2>/dev/null | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | sort -u | wc -l)
  echo "$enc: $count"
done
```

Use the encoding with the highest sane record count. For AWAKES/MyASP, CP932 is usually correct.

## Escalation Checklist

Escalate to Satoshi when:

- A customer asks for a refund or cancellation.
- A customer is angry, posting publicly, or threatening to leave.
- The problem affects multiple customers.
- Vercel/Supabase/Resend credentials or billing access is needed.
- MyASP payment status is unclear.

Escalate to engineering/Codex when:

- AI coaching returns "応答に失敗しました".
- Chat replies hang or history fails to load.
- Paid users are shown as free users.
- Support notifications stop arriving.
- Diagnosis answers/results mismatch.

## What Staff Should Not Do

- Do not manually change many users at once without a written query and verification result.
- Do not delete support tickets.
- Do not close a ticket only because a reply was sent; use `対応中` until confirmed.
- Do not send passwords in plain chat.
- Do not paste API keys or webhook secrets into public docs or GitHub issues.
- Do not tell customers that every ChatGPT conversation history can be restored inside ACTI.

## Recommended Onboarding For A New Staff PC

1. Confirm the staff can log into `awakes2025@gmail.com`.
2. Confirm the staff can log into ACTI with `awakes2025@gmail.com`.
3. Confirm the staff can open `/admin/support`.
4. Confirm GitHub repository access if the staff will ask Codex to make code changes.
5. Confirm Vercel/Supabase/Resend read access if the staff will investigate production incidents.
6. Keep secrets in a password manager.
7. Share this runbook and the ACTI `AGENTS.md` rules.

## Broadcast Email Draft

Subject: `ACTIコーチングの不具合修正とお詫び`

```
ACTIをご利用いただいている皆さま

いつもACTIをご利用いただきありがとうございます。

このたび、一部の環境でAIコーチングの返信が返ってこない、送信中のまま止まる、「応答に失敗しました」と表示されるなどの不具合が発生しておりました。

ご不便をおかけした皆さま、またご連絡をいただいていたにもかかわらず確認や対応が遅くなってしまった皆さまに、心よりお詫び申し上げます。

現在、関連する応答処理と入力欄まわりの修正を反映しております。
お手数ですが、一度ACTIにログインし直していただき、AIコーチングを改めてお試しください。

ACTIログインページ:
https://act-diagnosis-site.vercel.app/login

もし現在も同じ症状が出る場合は、サポートページから以下を添えてご連絡ください。

- ご登録メールアドレス
- 表示されたエラーメッセージ
- 可能であれば画面のスクリーンショット

今後は不具合の検知とサポート通知の確認体制を見直し、同じような見落としが起きないよう改善してまいります。

このたびはご迷惑をおかけし、本当に申し訳ございませんでした。

ACTIサポート
```
