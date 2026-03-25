# ACT診断コーチングサイト

ACT診断（Awakening Consciousness Type Exam）に基づくコーチングAIボット付き会員サイト。

## 技術スタック

- **フロントエンド**: Next.js 14 (App Router) + TypeScript + Tailwind CSS
- **バックエンド**: Next.js API Routes
- **認証・DB**: Supabase (Auth + PostgreSQL)
- **AI**: OpenAI GPT-4o
- **デプロイ**: Vercel推奨

## セットアップ手順

### 1. Supabaseプロジェクトの作成

1. [Supabase](https://supabase.com) でアカウント作成・新規プロジェクト作成
2. `supabase/schema.sql` をSQL Editorで実行してテーブルを作成
3. プロジェクトの Settings → API から以下を取得:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

### 2. OpenAI APIキーの取得

1. [OpenAI Platform](https://platform.openai.com) でAPIキーを取得
2. `OPENAI_API_KEY` として設定

### 3. 環境変数の設定

```bash
cp .env.local.example .env.local
```

`.env.local` を編集して各値を設定:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
OPENAI_API_KEY=sk-...
```

### 4. インストールと起動

```bash
npm install
npm run dev
```

http://localhost:3000 でアクセス可能。

### 5. 管理者アカウントの作成

1. サイトで通常のユーザー登録を行う
2. Supabase管理画面 → Table Editor → profiles テーブル
3. 該当ユーザーの `role` を `admin` に変更

### 6. Vercelへのデプロイ

```bash
npm install -g vercel
vercel
```

Environment Variables をVercelのダッシュボードで設定。

## 機能一覧

### ユーザー機能
- **会員登録・ログイン**: メール+パスワード認証
- **ACT診断テスト**: 122問の診断（意識レベル47問 + 性格タイプ75問）
- **追加質問**: レベル4以上の場合の成長・未熟さ質問
- **診断結果**: タイプコード（27種類）× 意識レベル（1-6段階）
- **AIコーチング**: 診断結果に基づくGPT-4oによるパーソナライズドコーチング

### 管理者機能
- **ダッシュボード**: ユーザー数・診断数・ボット状態の概要
- **ユーザー管理**: アクティブ/非アクティブ切替、ロール変更
- **サイト設定**: AIボットのON/OFF、メンテナンスモード

## プロジェクト構造

```
src/
├── app/
│   ├── page.tsx              # ランディングページ
│   ├── layout.tsx            # ルートレイアウト
│   ├── globals.css           # グローバルスタイル
│   ├── login/page.tsx        # ログイン
│   ├── register/page.tsx     # 新規登録
│   ├── diagnosis/page.tsx    # 診断テスト
│   ├── results/
│   │   ├── page.tsx          # 結果一覧
│   │   └── [id]/page.tsx     # 結果詳細
│   ├── chat/page.tsx         # AIコーチング
│   ├── admin/
│   │   ├── page.tsx          # 管理ダッシュボード
│   │   ├── users/page.tsx    # ユーザー管理
│   │   └── settings/page.tsx # サイト設定
│   └── api/
│       ├── chat/route.ts     # チャットAPI
│       └── admin/
│           ├── users/route.ts    # ユーザー管理API
│           └── settings/route.ts # 設定API
├── components/
│   ├── Header.tsx            # ナビゲーションヘッダー
│   ├── AuthGuard.tsx         # 認証ガード
│   └── AdminGuard.tsx        # 管理者ガード
├── data/
│   ├── consciousness-questions.ts  # 意識レベル質問（47問）
│   ├── personality-questions.ts    # 性格タイプ質問（75問）
│   ├── scoring.ts                  # スコアリングロジック
│   ├── type-names.ts               # タイプ名マッピング
│   └── coaching-system-prompt.ts   # AIシステムプロンプト
├── lib/
│   ├── supabase.ts           # Supabaseクライアント
│   ├── openai.ts             # OpenAIクライアント
│   └── types.ts              # TypeScript型定義
docs/
└── theory-mapping.md         # 心理学理論マッピング・改善提案
supabase/
└── schema.sql                # データベーススキーマ
```

## 心理学的基盤

8つの理論を統合:
1. ビッグファイブ理論
2. 自己決定理論 (SDT)
3. マズローの欲求階層
4. グレーブス理論 (Spiral Dynamics)
5. デビッド・ホーキンズ意識レベル理論
6. ユング類型論
7. 交流分析 (TA)
8. ケン・ウィルバー統合理論 (AQAL)

詳細な理論マッピングと改善提案は `docs/theory-mapping.md` を参照。

## 著作権

ACT診断は三凛さとしが開発した独自の診断ツールです。著作権法により保護されています。
