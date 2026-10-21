# ai_backoffice — 承認付きAIバックオフィス

エージェントが経理実務アクション（**返金 / クレジットノート発行 / サブスク解約**、
オプションで**顧客残高の付与**）を**理由文つきで起案**し、
[Stripe Approvals](https://docs.stripe.com/account/approvals) による**人間の承認が
なければ実行されない**ことを、動くコードで示すデモ。

**主張**: Stripe 公式の二者承認機能の上に、AI の「起案（propose）」レイヤーだけを
載せる。承認 UI は自作しない — 承認は Stripe Dashboard の Requests 画面で人間が行う。
金が動くアクションだけ人間の承認を挟み、動かないアクションは素通りする、という
構造をそのまま見せる。M9 では、エージェントが暴走して返金を連発したときに
rate limit + **Block** ルールで止まることも見せる。

すべて **test mode / sandbox**。本番キーは使わない。

> 仕様の確認日: **2026-10-20**（Stripe 公式ドキュメント再読）。ドキュメントで確認した
> ことと、ライブで確認したことは [`docs/live-verification.md`](docs/live-verification.md)
> に分けて記録している。

---

## このデモが示していること

- agent-tagged key で返金・クレジットノート発行・解約を実行しようとすると、Stripe が
  `approval_required` を返し、**実行がブロックされる**。
- エージェントは根拠（問い合わせID・顧客ID・金額・判断根拠）を含む理由文を生成し、
  approval request に **update で後付け（attach）** する（Stripe が自動提出済み）。
- 人間が Dashboard で承認/却下すると、承認後は **Stripe 側がアクションを自動実行**し、
  結果が `v2.core.approval_request.*` webhook で戻る。webhook 側は実行結果の
  オブジェクト（refund / credit_note など）を取得し、起案と一致するかを確かめる。
- 金額に影響しない軽微な操作（メタデータ更新）は承認を挟まず素通りする（対比）。
- **暴走シナリオ（M9）**: 短時間に返金を連発すると、rate limit 条件つきの Block ルールで
  4件目以降が即時拒否される。各リクエストが「即時実行 / approval_required / Block」の
  どれになったかを1行ずつログに残す。
- **MCP 経路（M10）**: 同じ返金を Stripe MCP（`https://mcp.stripe.com`）経由でも起案し、
  直接 API との差を記録する。
- 誰が/何を/なぜ起案し、誰が承認し、Stripe 側で何が起きたかが JSONL 監査ログに残る。

---

## アーキテクチャ（処理の流れ）

```
 顧客の問い合わせ (fixtures/inquiries.json)
        │
        ▼
 起案エージェント (src/agent)
   ├─ planner      : 問い合わせ→アクション種別/対象ID/金額 を決定
   ├─ justification: 理由文を生成（承認ルールの justification instructions と同項目）
   └─ execute      : agent-tagged key で Stripe v1 を実行（生fetch）
        │                     ※ M10: 同じ返金を Stripe MCP の stripe_api_write 経由でも
        ▼
 Stripe API ──┬─▶ 2xx                      … 即時実行（ルール対象外）
              ├─▶ approval_required        … 実行されず、承認要求が自動でレビューへ提出される
              └─▶ Block                    … 即時拒否（M9。エラーの形は B-9 で確定）
        │
        ▼ (approval_required のとき)
 理由文の update（Stripe-Version: 2026-09-30.preview）
   POST /v2/core/approval_requests/{id}/update   ← ガイドの記述
   POST /v2/core/approval_requests/{id}          ← API リファレンスの記述（404 時に自動フォールバック）
        │
        ▼
 Stripe Dashboard > Settings > Approvals > Requests  ── 人間が承認/却下 ──┐
        │                                                                 │
        │ 承認されると Stripe がアクションを自動実行                        │
        ▼                                                                 ▼
 webhook (v2.core.approval_request.*)  ─▶  監査ログ logs/audit.jsonl
   created / approved / succeeded / rejected / canceled / expired / failed （7種）
   succeeded では approval request を取得し、実行結果のオブジェクトを記録

 各リクエストの結果（即時実行 / approval_required / Block / エラー）─▶ logs/requests.jsonl
```

- 起案（propose）は **同期的に承認を待たない**。承認待ちは待ち状態として終わる。
- 承認後の実行は **Stripe が行う**。こちらから再実行しない。
- `approved` と `succeeded` は別イベントなので両方を記録して区別する。

---

## Stripe Approvals の対応アクションと本デモの対象

承認ルールを付けられる操作（[Set up two-party approvals](https://docs.stripe.com/account/approvals)、
2026-10-20 時点）は次の7つ。**請求書・invoice item は含まれない**（M8 で請求書シナリオを
クレジットノートに差し替えた理由）。

| Stripe の対象操作 | 本デモ |
|---|---|
| 銀行口座の追加・更新・削除 | — |
| 管理者の招待 | — |
| PaymentIntent の作成 | —（M11 の x402 で関係） |
| **返金の作成** | INQ-001〜003（主線）、M9 暴走、M10 経路比較 |
| **サブスクの作成・解約** | INQ-005（解約。不可逆アクションの例） |
| **クレジットノートの作成** | INQ-004（請求済み金額の減額） |
| **顧客残高取引の作成** | INQ-007（返金の代わりに残高付与で補償。**フラグで有効化、既定は無効**） |

---

## 承認フローの制約（押さえておくこと）

- **Approval Requests v2 API は 2026-08-26 に public preview**。`approvals_product_preview`
  への登録が今も必要かは**ドキュメントに記載がない**。2026-10-21、sandbox で Settings > Approvals が
  表示されることは確認済み（B-0）。
  Settings > Approvals が出ない場合、gated アクションは素通りし、コードは
  `rule_not_enforced` を警告する。
- **理由文の付与は update**：`approval_required` が返ると Stripe が承認要求を
  自動的にレビューへ提出する。エージェントは `reason` を後付けするだけ。
  `Stripe-Version` は `2026-09-30.preview`（`STRIPE_PREVIEW_VERSION` で上書き可）。
  パスはドキュメント間で食い違っている（ガイド=`/{id}/update`、API リファレンス=`/{id}`）
  ため、既定ではガイドのパスを試し、ルートが無い 404 のときだけリファレンスのパスに
  切り替える（`STRIPE_APPROVAL_UPDATE_PATH=auto|update|id`）。どちらで通ったかを記録する（B-4）。
- **ルールの条件は amount / actor / rate limit の3種**、`and` / `or` で組み合わせ可。
  **制御は Require approval か Block の2種で、1ルールに1つ**。**同じ操作に有効なルールは
  1つだけ**。ルール作成は Dashboard から（ルールの API はドキュメントに無い）。
- **承認されないまま14日で自動 expired**。デモでは14日待てないので、cancel API で
  `canceled` を出して webhook を確認する（`npm run approvals:cancel`）。
- **agent タグ**: restricted key の作成時に「Authorizing agent access to your account」を
  選ぶと付く。secret key には付かない。
- **デフォルトルール**: agent タグ付きキーには Stripe 管理のデフォルトルールがある。
  ただし内容がページ間で揃っていない（Approvals ページ=返金の作成・サブスクの解約、
  API keys ページ=payouts・refunds・アカウント設定変更）。**実際に入っていたのは返金の作成とサブスクの解約の2件だけ**
  （2026-10-21 確認、B-7）。どちらも条件は Actor = Agent key、レビュアーはロール指定（Analyst ほか）なので、
  メール通知を受けるには本人を個人として追加する。
- **画面の表記**: 制御「Submit for approval」がドキュメントの「Require approval」、Actor の値「Agent key」が
  「agent-tagged API keys」にあたる。
- **単一メンバーのアカウントでも成立**：agent-tagged key は管理者と独立した actor なので、
  actor 条件を `agent-tagged API keys` にしたルールは1人のアカウントでも保存でき、
  起案=agent / 承認=人間 の分離が成り立つ。
- **承認は Settings > Approvals > Requests 画面**で人間が行う。自分の起案は自分で承認できない。

---

## 経路の比較（M10）

| | 直接 API（CLI 経路） | Stripe MCP + agent キー | Stripe MCP + OAuth（**デモ対象外**） |
|---|---|---|---|
| 認証 | agent タグ付き restricted key | agent タグ付き key を `Authorization: Bearer` | ユーザーの OAuth セッション |
| 人間の確認 | Approvals（approval_required → Dashboard で承認） | Approvals が掛かるはず（ライブ確認対象） | 返金・outbound payment などで**確認URL**が返る。承認すると approval token が出て、エージェントが**再実行**する。24時間で失効 |
| 返金ツール | `POST /v1/refunds` | `stripe_api_write` → Create refund | 同左 |
| 本デモでの確認 | `npm run demo:mcp` で両経路を同じ返金で比較し、approval_required / approval request の作成 / 確認URL の有無を記録 | 同左 | ドキュメントの記述のみ |

> **注意（12月以降）**: Stripe MCP は **2026-11-30 までに移行が必要**。12月以降、
> **agent タグの無いキー**（full-access の secret key、agent タグの無い restricted key）は
> MCP で `401`（OAuth discovery challenge 付き）になる。MCP 経路には必ず agent タグ付きキーを使う。

---

## セットアップ

### 前提

- Node.js 20+（開発は 22 系）
- Stripe sandbox（test mode）のアカウント、**agent-tagged restricted key**、Stripe CLI

### 手順

```bash
# 1) 依存インストール
npm install

# 2) 環境変数
cp .env.example .env
#   STRIPE_SECRET_KEY     … 通常の test キー（seed・status・webhook での取得用）
#   STRIPE_AGENT_KEY      … agent タグ付き restricted key（起案用。rk_test_...）
#   STRIPE_WEBHOOK_SECRET … 後述の stripe listen が出力する whsec_...

# 3) 承認ルールを設定（人間の管理者操作）
#   docs/APPROVAL_RULES.md のとおり、Dashboard > Settings > Approvals で設定。

# 4) テストデータを投入（冪等）
npm run seed              # fixtures/seeded.json が生成される

# 5) webhook を受ける（別ターミナル2つ）
npm run webhook           # localhost:4242/webhook で待受
stripe listen --forward-to localhost:4242/webhook
#   表示される whsec_... を .env の STRIPE_WEBHOOK_SECRET に入れて webhook を再起動

# 6) デモ実行
npm run status            # キー・バージョン・承認リクエスト件数・フィクスチャ状態を確認
npm run demo              # seed → 起案 → 承認待ち → 反映 まで通しで流れる
```

> **ルール設定は人間の管理者操作**であり、このリポジトリのコードは行わない
> （承認画面を自作しないのがデモの主張のため）。

### コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm run seed` | M1: test データを冪等に構築、`fixtures/seeded.json` を出力（M8 で open 請求書と少額返金用プールを追加） |
| `npm run status` | キーの agent タグ判定・Stripe-Version・承認リクエスト件数（承認待ち/承認済み/却下/失効…）・観測されたルール名・フィクスチャ消費状況・リクエスト結果の集計 |
| `npm run propose` | M3: 全問い合わせを起案（`-- --only=INQ-001,INQ-004`、`--with-balance` で INQ-007 も） |
| `npm run webhook` | M4: 承認イベントを受けて監査ログへ反映 |
| `npm run demo` | M5: seed→起案→待機→反映（`-- --only=...` `--skip-seed` `--no-wait` `--timeout=秒` `--with-balance`） |
| `npm run demo:runaway` | M9: 少額返金を連続起案（`-- --count=N --interval=秒 --amount=円 --rule-set=block\|approval`） |
| `npm run demo:mcp` | M10: 同じ返金を CLI / MCP の2経路で起案して比較（`-- --amount=円 --route=both\|cli\|mcp`） |
| `npm run approvals:cancel` | 承認待ちの approval request を取消（`-- <apreq_id>` または `--fixture=RUNAWAY#4`）。B-5 の canceled 確認用 |
| `npm run audit` | 監査ログを表形式で表示（`-- --json` で生JSON） |
| `npm run evidence` | `logs/requests.jsonl` の生レスポンスを伏字にして Markdown で出力（`-- --run=… --outcome=blocked --kind=approval_update --last=N`） |
| `npm run x402:check` | M11: machine payments（x402）が使えるかの確認（`-- --probe-deposit-address` で deposit address の作成も試す） |
| `npm run typecheck` | 型チェック |

### 機能フラグ・上書き用の環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `STRIPE_PREVIEW_VERSION` | `2026-09-30.preview` | v2 approval request API の `Stripe-Version` |
| `STRIPE_APPROVAL_UPDATE_PATH` | `auto` | 理由文 update のパス（`auto` / `update` / `id`） |
| `ENABLE_BALANCE_COMPENSATION` | `false` | INQ-007（顧客残高付与）を有効化。`--with-balance` でも可 |
| `STRIPE_MCP_URL` | `https://mcp.stripe.com` | M10 の MCP エンドポイント |
| `STRIPE_MCP_WRITE_ARGS` | なし | `stripe_api_write` の引数テンプレート（ライブのスキーマが自動対応できなかったとき） |
| `STRIPE_API_BASE_URL` | `https://api.stripe.com` | 生 HTTP 経路の宛先。ローカルのモックで動作確認するときだけ使う |

---

## 問い合わせケース（fixtures/inquiries.json）

| # | 内容 | 期待される挙動 |
|---|---|---|
| INQ-001 | 少額の返金依頼（二重課金・正当） | 起案 → 承認 → 実行 |
| INQ-002 | 高額の返金依頼（¥80,000） | しきい値超で承認必須 → 承認 → 実行 |
| INQ-003 | 根拠が薄い返金依頼 | 起案 → 却下 → 未実行 |
| INQ-004 | **クレジットノート発行**（請求書 ¥30,000 のうち未実施分 ¥15,000 を減額） | 起案 → 承認 → 実行（credit_note が作られる） |
| INQ-005 | サブスク解約依頼 | 起案 → 承認 → 実行 |
| INQ-006 | メタデータ更新（軽微） | 承認を挟まず即時実行（対比） |
| INQ-007 | 障害の補償を返金ではなく**残高付与**で（¥2,000）。**既定は無効** | 起案 → 承認 → 実行（customer_balance_transaction が作られる） |

M9・M10 は問い合わせではなく、seed が作る少額返金用のプール（`runaway-pool`、¥20,000）から
部分返金を起案する。INQ のフィクスチャは消費しない。

---

## 監査の観点

- **監査ログ（本リポジトリ）**: `logs/audit.jsonl`。1行1レコードで、起案時刻・
  fixture ID・顧客ID・アクション・対象ID・金額・理由文全文・approval_request ID・
  dashboard_url・expires_at・経路（cli/mcp）・各イベントの受信時刻とステータス遷移・
  実行結果のオブジェクト・最終結果を残す。append-only。`npm run audit` で整形表示。
- **リクエストログ（M9）**: `logs/requests.jsonl`。agent の各リクエストが
  即時実行 / approval_required / Block / エラーのどれになったか、HTTP ステータス、
  Stripe の Request-Id、成功以外は生のレスポンス本文を残す。
- **Approvals のイベント**: Stripe Dashboard の **Security history** に残る。
- **API リクエスト**: Stripe **Workbench の Logs** に残る（agent key の実行や理由文の update）。

---

## ACP / x402 との位置づけの違い

本デモは**バックオフィスの承認**レイヤー（社内の人間が agent の起案を承認する）で
あり、ACP / Shared Payment Token のような**エージェント購入側**の決済プロトコル
（顧客の代理として agent が支払う）とは別レイヤーである。

M11 は、x402（machine payments）で**受け取った**ステーブルコインの支払いを、
通常の返金として起案・承認する例（Stripe は x402 の支払いを PaymentIntent として記録し、
返金も通常の Refunds API で扱える）。**現時点では実装を止めている**:
このアカウントで machine payments が使えることを確認できていないため
（米国外は machine-payments@stripe.com にアカウントIDを送って申請が必要）。
`npm run x402:check` で利用可否を確かめ、使えるようになったら再開する。
経緯は [`docs/live-verification.md`](docs/live-verification.md) の M11 節。

---

## 未検証リスト（実キーを入れた環境で最初に確認すること）

ここまでの実装はドキュメント（2026-10-20 再読）に対して書いてあり、以下は実キーでの
**ライブ確認がまだ**。食い違いが出た場合、コードは正常系にフォールバックせず、
HTTP ステータス/エラー本文をそのまま記録する。結果は
[`docs/live-verification.md`](docs/live-verification.md) に、日付・バージョン・伏字済みの
生レスポンスとともに追記する（`npm run evidence` で出力）。

| # | 未検証項目 | 依存するコード | 確認方法 |
|---|---|---|---|
| B-2 | `approval_required` の本文形状（`error.approval_request.{id,action,status,dashboard_url,expires_at}`） | `src/stripe-client.ts` `parseApprovalRequiredBody` | `npm run propose -- --only=INQ-001` → `npm run evidence -- --outcome=approval_required` |
| B-4 | 理由文 update（`2026-09-30.preview`）の要求/応答形状と、通るパス（`/update` か `/{id}` か） | `src/stripe-client.ts` `updateApprovalRequest` | `npm run evidence -- --kind=approval_update`（note に試したパスと結果） |
| B-5 | `v2.core.approval_request.*` webhook（7種）の受信と thin event の形状 | `src/webhook.ts` | 承認・却下・`npm run approvals:cancel` で canceled。expired は14日待てないので canceled で代替 |
| B-6 | クレジットノート発行に付けたルールで `approval_required` が返るか | `src/agent/execute.ts`（credit note） | `npm run propose -- --only=INQ-004` |
| B-8 | Stripe agent skills（`stripe-docs` 等）の導入 | — | 導入可能環境で https://docs.stripe.com/skills |
| B-9 | Block で拒否されたときのエラーの形 | `src/stripe-client.ts` `detectBlock` | `npm run demo:runaway -- --rule-set=block` → `npm run evidence -- --outcome=blocked`（未分類なら `--outcome=error`） |
| B-10 | ステーブルコインの PaymentIntent への返金が Approvals の返金ルールに同じように掛かるか | M11（未実装） | M11 再開後 |

**消化済み**

| # | 項目 | 根拠 |
|---|---|---|
| ~~B-1~~ | agent-key の身元判定：単一メンバーのアカウントでも agent-tagged key は管理者と独立した actor | Approvals ページ「Accounts with a single team member」 |
| ~~旧 B-6~~ | 承認→自動実行時に pending invoice item が請求書へ取り込まれるか → **対象外**（請求書の作成は承認対象の操作ではない） | Approvals ページ「Supported actions」 |
| ~~B-0~~ | Settings > Approvals が出るか → **出る**（2026-10-21、sandbox） | 本人のスクショ（`docs/live-verification.md`） |
| ~~B-7~~ | デフォルトルールの中身 → **返金の作成・サブスクの解約の2件のみ**（Actor = Agent key、Submit for approval、レビュアーはロール指定） | 同上。ライブ確認 |
| ~~旧 B-7~~ | 請求書作成が agent-key デフォルトルールの対象か → **対象外**（同上） | 同上 |

---

## ディレクトリ

```
src/
  config.ts          環境変数（test キー強制・両キー分離・preview バージョン・機能フラグ）
  types.ts           ドメイン型
  logger.ts          コンソール用の構造化ログ
  manifest.ts        fixtures/seeded.json の読み取り
  stripe-client.ts   SDK(seed) + 生fetch(agent実行/v2 approval request) + 応答の分類(approval_required/Block)
  request-log.ts     リクエスト単位のログ(JSONL)
  seed.ts            M1: test データ投入（冪等）
  agent/
    planner.ts       問い合わせ→アクション決定（決定論的分類）
    justification.ts 理由文生成（承認ルールの instructions と同項目）
    execute.ts       アクション→Stripe v1 呼び出し
    propose.ts       M3: 起案オーケストレーション
  webhook.ts         M4: 承認イベント受信→監査ログ反映（実行結果オブジェクトも記録）
  audit-store.ts     監査ログ(JSONL) 追記/読み取り
  audit.ts           監査ログ表示CLI
  demo.ts            M5: 通しデモ
  status.ts          状態レポート（M8 で拡張）
  runaway.ts         M9: 暴走シナリオ
  mcp-client.ts      M10: Stripe MCP の最小クライアント（Streamable HTTP / JSON-RPC）
  routes.ts          M10: CLI / MCP 経路比較
  cancel.ts          approval request の取消（B-5）
  evidence.ts        生レスポンスの伏字出力（live-verification 用）
  x402-check.ts      M11: machine payments の利用可否確認
fixtures/
  inquiries.json     7件の問い合わせ（日本語。INQ-007 はフラグ付き）
  seeded.json        seed が生成（gitignore）
docs/
  live-verification.md  ドキュメント確認とライブ確認の記録（M8〜）
  VERIFICATION.md       M0 環境確認レポート（履歴）
  APPROVAL_RULES.md     承認ルール定義表（人間が設定）
```
