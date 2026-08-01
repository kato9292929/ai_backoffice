# ai_backoffice — 承認付きAIバックオフィス

エージェントが経理実務アクション（**返金 / 請求書発行 / サブスク解約**）を
**理由文つきで起案**し、[Stripe Approvals](https://docs.stripe.com/account/approvals)
による**人間の承認がなければ実行されない**ことを、動くコードで示すデモ。

**主張**: Stripe 公式の二者承認機能の上に、AI の「起案（propose）」レイヤーだけを
載せる。承認 UI は自作しない — 承認は Stripe Dashboard の Requests 画面で人間が行う。
金が動くアクションだけ人間の承認を挟み、動かないアクションは素通りする、という
構造をそのまま見せる。

すべて **test mode**。本番キーは使わない。

---

## このデモが示していること

- agent-tagged key で返金・請求書発行・解約を実行しようとすると、Stripe が
  `approval_required` を返し、**実行がブロックされる**。
- エージェントは根拠（問い合わせID・顧客ID・金額・判断根拠）を含む理由文を生成し、
  approval request に **submit** する。
- 人間が Dashboard で承認/却下すると、承認後は **Stripe 側がアクションを自動実行**し、
  結果が `v2.core.approval_request.*` webhook で戻る。
- 金額に影響しない軽微な操作（メタデータ更新）は承認を挟まず素通りする（対比）。
- 誰が/何を/なぜ起案し、誰が承認し、Stripe 側で何が起きたかが JSONL 監査ログに残る。

---

## アーキテクチャ（処理の流れ）

```
 顧客の問い合わせ (fixtures/inquiries.json)
        │
        ▼
 起案エージェント (src/agent)
   ├─ planner      : 問い合わせ→アクション種別/対象ID/金額 を決定
   ├─ justification: 理由文を生成（M2のjustification instructionsと同項目）
   └─ execute      : agent-tagged key で Stripe v1 を実行（生fetch）
        │
        ▼
 Stripe API ──▶ approval_required (error.approval_request)
        │              ← gated アクションは実行されず承認要求が生成される
        ▼
 POST /v2/core/approval_requests/{id}/submit   （理由文=reason, preview版ヘッダ）
        │
        ▼
 Stripe Dashboard > Requests  ── 人間が承認/却下 ──┐
        │                                          │
        │ 承認されると Stripe がアクションを自動実行 │
        ▼                                          ▼
 webhook (v2.core.approval_request.*)  ─▶  監査ログ logs/audit.jsonl
   approved / succeeded / rejected / canceled / failed   （状態遷移を追記）
```

- 起案（propose）は **同期的に承認を待たない**。承認待ちは待ち状態として終わる。
- 承認後の実行は **Stripe が行う**。こちらから再実行しない。
- `approved` と `succeeded` は別イベントなので両方を記録して区別する。

---

## Stripe Approvals の対応アクションと本デモの3つ

Stripe Approvals は複数のアクションを承認対象にできる（公式ドキュメントの
Supported actions を参照）。本デモではそのうち3つを使う:

| 本デモの対象 | Stripe の action | 位置づけ |
|---|---|---|
| 返金 | `create_refund` | 主線。金額条件つきルールの例 |
| 請求書作成 | Invoice is created | 起案の粒度が違う例（請求側の金額） |
| サブスク解約 | Subscription is cancelled | 取り消しづらい不可逆アクションの例 |

---

## 承認フローの制約（押さえておくこと）

- **未提出は 24 時間で失効**：`approval_required` で自動生成されても、submit
  しない限りレビュー対象にならず 24h で失効する。→ エージェントは必ず submit する。
- **提出済みは 14 日で失効**。
- **自分の起案は自分で承認できない**：起案 agent と承認者は別人格にする。
- **1アクションにつき有効化できるルールは1つ**。

---

## セットアップ

### 前提

- Node.js 20+（開発は 22 系）
- Stripe test mode のアカウント、**agent-tagged key**、Stripe CLI

### 手順

```bash
# 1) 依存インストール
npm install

# 2) 環境変数
cp .env.example .env
#   STRIPE_SECRET_KEY   … 通常の test キー（seed 用）
#   STRIPE_AGENT_KEY    … agent-tagged test キー（起案用）
#   STRIPE_WEBHOOK_SECRET … 後述の stripe listen が出力する whsec_...

# 3) 承認ルールを設定（人間の管理者操作）
#   docs/APPROVAL_RULES.md の3表のとおり、Dashboard > Settings > Approvals で設定。
#   ※ ルール設定は API ではなく Dashboard 操作。設定完了を確認してから起案を運用する。

# 4) テストデータを投入（冪等）
npm run seed              # fixtures/seeded.json が生成される

# 5) webhook を受ける（別ターミナル2つ）
npm run webhook           # localhost:4242/webhook で待受
stripe listen --forward-to localhost:4242/webhook
#   表示される whsec_... を .env の STRIPE_WEBHOOK_SECRET に入れて webhook を再起動

# 6) デモ実行
npm run demo              # seed → 起案 → 承認待ち → 反映 まで通しで流れる
```

> **ルール設定は人間の管理者操作**であり、このリポジトリのコードは行わない
> （承認画面を自作しないのがデモの主張のため）。

### コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm run seed` | M1: test データを冪等に構築、`fixtures/seeded.json` を出力 |
| `npm run propose` | M3: 全問い合わせを起案（`-- --only=INQ-001,INQ-004` で絞り込み） |
| `npm run webhook` | M4: 承認イベントを受けて監査ログへ反映 |
| `npm run demo` | M5: seed→起案→待機→反映（`-- --only=...` `--skip-seed` `--no-wait` `--timeout=秒`） |
| `npm run audit` | 監査ログを表形式で表示（`-- --json` で生JSON） |
| `npm run typecheck` | 型チェック |

収録用にケースを絞る例:

```bash
npm run demo -- --only=INQ-001,INQ-003 --timeout=300
```

---

## 問い合わせケース（fixtures/inquiries.json）

| # | 内容 | 期待される挙動 |
|---|---|---|
| INQ-001 | 少額の返金依頼（二重課金・正当） | 起案 → 承認 → 実行 |
| INQ-002 | 高額の返金依頼（¥80,000） | しきい値超で承認必須 → 承認 → 実行 |
| INQ-003 | 根拠が薄い返金依頼 | 起案 → 却下 → 未実行 |
| INQ-004 | 請求書発行依頼（¥30,000） | 起案 → 承認 → 実行 |
| INQ-005 | サブスク解約依頼 | 起案 → 承認 → 実行 |
| INQ-006 | メタデータ更新（軽微） | 承認を挟まず即時実行（対比） |

---

## 監査の観点

- **監査ログ（本リポジトリ）**: `logs/audit.jsonl`。1行1レコードで、起案時刻・
  fixture ID・顧客ID・アクション・対象ID・金額・理由文全文・approval_request ID・
  dashboard_url・expires_at・各イベントの受信時刻とステータス遷移・最終結果を残す。
  append-only（各イベントで最新スナップショットを追記）。`npm run audit` で整形表示。
- **Approvals のイベント**: Stripe Dashboard の **Security history** に残る。
- **API リクエスト**: Stripe **Workbench の Logs** に残る（agent key の実行や submit）。

---

## ACP 等との位置づけの違い

本デモは**バックオフィスの承認**レイヤー（社内の人間が agent の起案を承認する）で
あり、ACP / Shared Payment Token のような**エージェント購入側**の決済プロトコル
（顧客の代理として agent が支払う）とは別レイヤーである。本デモは購入側の実装は
行わない。

---

## 未検証リスト（実キーを入れた環境で最初に確認すること）

この実装は公開ドキュメント記載の仕様に対して書いてあり、以下は Stripe への
ネットワーク到達・実キーが無い開発環境では**ライブ検証できていない**（M0 §B）。
食い違いが出た場合、コードは正常系にフォールバックせず、HTTP ステータス/エラー本文を
そのまま出す。詳細は [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

| # | 未検証項目 | 依存するコード | 最初に踏む確認 |
|---|---|---|---|
| B-1 | Approvals がアカウント/ test mode で有効か | 全体 | ルール1本設定後に `npm run propose -- --only=INQ-001` を実行し `approval_required` が返るか |
| B-2 | `approval_required` の本文形状（`error.approval_request.{id,action,status,dashboard_url,expires_at}`） | `src/stripe-client.ts` `parseApprovalRequired` | 上記実行時のレスポンスをログで確認 |
| B-3 | agent-tagged key で gate が発火するか | `src/stripe-client.ts` `agentRequest` | 同上。素通りしたら `rule_not_enforced` 警告が出る |
| B-4 | `/v2/core/approval_requests/{id}/submit`（preview版）の要求/応答形状 | `src/stripe-client.ts` `submitApprovalRequest` | submit のHTTPステータス/ボディをログで確認 |
| B-5 | `v2.core.approval_request.*` webhook の受信と thin event の形状 | `src/webhook.ts` | `stripe listen` 接続後、承認操作でイベントが届き id が取れるか |
| B-6 | 承認→自動実行時に pending invoice item が請求書へ取り込まれるか | `src/agent/execute.ts`（invoice） | 承認後の invoice を Workbench Logs で確認 |
| B-7 | 承認ルールが API から作成可能か（本デモは Dashboard 前提） | — | Dashboard 設定で代替（`docs/APPROVAL_RULES.md`） |
| B-8 | Stripe agent skills（`stripe-docs` 等）の導入 | — | 導入可能環境で https://docs.stripe.com/skills |

---

## ディレクトリ

```
src/
  config.ts          環境変数（test キー強制・両キー分離）
  types.ts           ドメイン型
  logger.ts          コンソール用の構造化ログ
  manifest.ts        fixtures/seeded.json の読み取り
  stripe-client.ts   SDK(seed) + 生fetch(agent実行/submit) + approval_required解析
  seed.ts            M1: test データ投入（冪等）
  agent/
    planner.ts       問い合わせ→アクション決定（決定論的分類）
    justification.ts 理由文生成（M2と同項目）
    execute.ts       アクション→Stripe v1 呼び出し
    propose.ts       M3: 起案オーケストレーション
  webhook.ts         M4: 承認イベント受信→監査ログ反映
  audit-store.ts     監査ログ(JSONL) 追記/読み取り
  audit.ts           監査ログ表示CLI
  demo.ts            M5: 通しデモ
fixtures/
  inquiries.json     6件の問い合わせ（日本語）
  seeded.json        seed が生成（gitignore）
docs/
  VERIFICATION.md    M0 環境確認レポート
  APPROVAL_RULES.md  M2 承認ルール定義表（人間が設定）
```
