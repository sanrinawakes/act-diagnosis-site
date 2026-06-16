# AWAKES / ACTI サポート運用マニュアル

最終更新: 2026-06-17
対象: AWAKES / ACTI のサポート担当者、Codexで保守対応するスタッフ

## 目的

ACTIの問い合わせ、不具合、会員有効化、AIコーチング障害を、スタッフが自分のPCとCodexで対応できるようにするための手順書です。

主担当メールは `awakes2025@gmail.com` です。
既存の管理用メールは `181wyc@gmail.com`、通知復旧確認用の暫定受信先は `silversense.fzco@gmail.com` です。

## 現在の運用状態

- サポート通知メールは検証済みドメインの `noreply@silversense.cc` から送信します。
- サポート通知は `silversense.fzco@gmail.com` と `awakes2025@gmail.com` に届く設定です。
- `onboarding@resend.dev` は本番サポート通知に使ってはいけません。外部宛送信で403になった原因です。
- `awakes2025@gmail.com` はACTI管理者としてログインできます。
- サポート画面から返信したメールは、チケット内の返信履歴に残す運用です。
- 2026-06-16時点で、画像・スクリーンショット添付機能は未実装です。ユーザーにはメール返信で画像添付を依頼してください。

## スタッフに必要なアクセス

通常のサポート対応だけなら、最低限以下が必要です。

- `awakes2025@gmail.com` のGmail
- ACTIの `awakes2025@gmail.com` アカウント
- ACTI管理画面: `https://act-diagnosis-site.vercel.app/admin/support`

Codexで技術調査や修正まで行うスタッフには、追加で以下が必要です。

- GitHub: `sanrinawakes/act-diagnosis-site`
- Vercel: `sanrinawakes-projects` の `act-diagnosis-site`
- Supabase: `yszqmhgicggyrnmcqlde`
- Resend: 送信ログ確認
- MyASP: AWAKES会員CSV、Webhook設定確認
- APIキーやWebhook secretを保管するパスワードマネージャ

APIキー、Webhook secret、顧客CSV、個人情報をGitHubや公開ドキュメントに貼ってはいけません。

## 毎日の確認手順

1. `awakes2025@gmail.com` を開く。
2. 件名 `[ACTI サポート]` のメールを確認する。
3. メール内リンク、または以下から管理画面を開く。
   `https://act-diagnosis-site.vercel.app/admin/support`
4. `未対応` フィルターを見る。
5. チケットごとに以下を確認する。
   - 名前
   - メールアドレス
   - 件名
   - 症状またはエラーメッセージ
   - 発生日
   - スクリーンショットの有無
6. すぐ返信できるものは管理画面から返信する。
7. 返信後は `対応中` にする。
8. ユーザーから解決確認が取れたら `解決済み` にする。
9. 原因未確認の技術問題は `対応中` のままにして、Codexまたは開発担当へ回す。

## チケット分類

- アカウント / ログイン: 確認メール未達、ログイン不可、無料会員表示
- AIコーチング不具合: 応答失敗、送信中のまま止まる、履歴が出ない
- 診断不具合: 診断結果、回答、表示の問題
- 要望: 画像添付、文字サイズ、入力欄、操作性
- 支払い / 会員状態: MyASP決済、会員有効化、解約
- その他: 上記以外

## 返信ルール

- 最初に遅延や不便へのお詫びを書く。
- 「確認した事実」と「対応した内容」を分けて書く。
- 不明点は不明と書く。推測で断定しない。
- 「修正済み」と言う場合は、DB、コード、ログ、テスト結果の根拠を確認する。
- 画像添付が必要な場合は、メール返信でスクリーンショットを依頼する。
- 解決確認が取れるまで、チケットを `解決済み` にしない。

## 返信文は固定テンプレ化しない

固定文面をこのマニュアルへ溜め込まないでください。
スタッフはCodexに、確認済みのDB状態、修正済みのコード、ログ、未実装の点、再発時に必要な情報を渡して、そのチケット専用の返信文を作らせます。

文面より大事なのは、管理画面に返信履歴と根拠が残ることです。

## Codexに依頼するときの必須文

スタッフがCodexで調査や修正を依頼する場合、最初に必ず以下を書いてください。

```text
必ず /Users/sunsat/Documents/Claude/Projects/ACTI/AGENTS.md のルールを読んでから動いてください。
検証なしに「完了」と言わないでください。
DB、コード、ログ、テスト結果のいずれかで根拠を示してください。
```

Codexの回答で以下のような表現が出た場合は、証拠を出させてください。

- `たぶん直っています`
- `問題ないと思います`
- `完了です`
- `おそらく`
- `確認したはず`

## DB作業の絶対禁止事項

- `subscription_status <> 'active'` のような条件で一括更新しない。
- `subscription_status='cancelled'` のユーザーを一括救済で触らない。
- 有料会員の救済は `subscription_status = 'none'` または `subscription_status is null` のみを対象にする。
- 個別救済では、`profiles`、`pending_activations`、AWAKES有料会員の根拠を必ず確認する。
- `is_active`、`subscription_status`、`subscribed_at` を整合させる。

## AWAKES / MyASP CSVの読み方

AWAKES / MyASP のCSVはCP932文字を含むことがあります。SHIFT_JIS決め打ちは禁止です。

```bash
file -i target.csv
wc -c target.csv
grep -c "@" target.csv

for enc in UTF-8 SHIFT_JIS CP932 EUC-JP UTF-16 UTF-16LE; do
  count=$(iconv -f $enc -t UTF-8 target.csv 2>/dev/null | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | sort -u | wc -l)
  echo "$enc: $count"
done
```

件数が最大で、ファイルサイズやメールアドレス数と矛盾しないエンコーディングを採用してください。
AWAKES / MyASPは原則CP932を第一候補にします。

## スタッフが自走する範囲

スタッフに振る目的は、確認待ちでサポートや修正が止まる状態をなくすことです。
通常の問い合わせ、ログイン確認、AIコーチング不具合、サポート返信、PR作成、本番検証はスタッフがCodexで進めます。

対応中に必要な証拠は、管理画面のチケット履歴、PR、Vercel status、Supabase確認結果、Resendログとして残してください。

## Codex / 開発で処理するもの

- AIコーチングが応答しない
- 送信中のまま固まる
- 履歴が保存されない、または表示されない
- サポート通知が届かない
- MyASP webhookや会員有効化が怪しい
- Resendで送信失敗が出ている

## 運営責任者の承認が必要な例外

以下だけは、スタッフが「現状・証拠・選択肢・推奨対応」をまとめてから承認を取ります。丸投げは禁止です。

- 返金や金銭補償の承認
- 法務・炎上・公開クレーム対応
- 本番サービス停止を伴う大きな変更
- GitHub / Vercel / Supabase / Resend / MyASP の権限追加
- サービス方針や顧客への約束内容を変える判断

## 新しいスタッフPCの準備

1. `awakes2025@gmail.com` にログインできることを確認する。
2. ACTIに `awakes2025@gmail.com` でログインできることを確認する。
3. `/admin/support` を開けることを確認する。
4. Codexでコード修正まで行う場合は、GitHub権限を追加する。
5. 本番ログを見る場合は、Vercel、Supabase、Resendの権限を追加する。
6. MyASP確認を行う場合は、AWAKES側MyASPへのアクセスを追加する。
7. APIキーやsecretはパスワードマネージャで共有する。
8. このマニュアルと `AGENTS.md` を読ませる。

## 全体配信が必要な時

固定文例をこのマニュアルへ溜め込まないでください。
スタッフがCodexに、発生日時、影響範囲、修正済み内容、未実装内容、再発時の連絡方法を渡して、その時点の事実に合わせた文面を作らせます。
