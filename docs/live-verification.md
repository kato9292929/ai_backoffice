# ライブ検証の記録（M8〜）

**ドキュメントで確認したこと**（§1）と、**ライブで確認したこと**（§2）を分けて記録する。
ライブの結果は、日付・バージョン・**伏字済みの**生レスポンスとともに §2 に追記する
（`npm run evidence` が API キー・メールアドレス・個人情報フィールドを伏せ、顧客IDは末尾4文字だけ残す）。

凡例: ✅ 確認済み / ⚠️ 差分あり / ⏳ 未実施 / ⛔ 停止

---

## 1. ドキュメントで確認したこと（2026-10-20 再読）

読んだページ: [Set up two-party approvals](https://docs.stripe.com/account/approvals) /
[changelog 2026-08-26](https://docs.stripe.com/changelog/dahlia/2026-08-26/introduces-approval-requests-in-public-preview) /
[Approval Request API リファレンス](https://docs.stripe.com/api/v2/core/approval-requests/object?api-version=2026-09-30.preview)
（object / update / cancel / list / retrieve）/ [API keys](https://docs.stripe.com/keys#agent-keys) /
[MCP](https://docs.stripe.com/mcp) / [x402](https://docs.stripe.com/payments/machine/x402) /
[Machine payments](https://docs.stripe.com/payments/machine)

### 指示書の前提との照合

| # | 前提 | 結果 | 補足 |
|---|---|---|---|
| 1 | Approval Requests v2 API は 2026-08-26 に public preview | ✅ | changelog の endpoint 表は `cancel` / `list` / `retrieve` / `update`。**`approvals_product_preview` への登録が今も必要かは記載なし** → B-0 |
| 2 | `/update` のサンプルの Stripe-Version は `2026-09-30.preview` | ✅ / ⚠️ | ガイドのサンプルは確かに `2026-09-30.preview` + `POST …/{id}/update`。**API リファレンスの Update は `POST /v2/core/approval_requests/{id}`（`/update` なし）**。コードは既定でガイドのパスを試し、ルートが無い 404 のときだけリファレンスのパスへ切り替える。どちらが通ったかを記録（B-4） |
| 3 | 対象操作は7つ、請求書・invoice item は含まれない | ✅ / ⚠️ | ガイドの Supported actions は前提どおり。**ただし API リファレンスの `action` enum（2026-09-30.preview）にはクレジットノートと顧客残高取引が無く**、`invoice.create` / `charge.create` / `payout.create` / `transfer.create` などが並ぶ。クレジットノートに approval_required が本当に返るかは B-6 で確認 |
| 4 | 条件は amount / actor / rate limit、制御は Require approval / Block、同じ操作に有効なルールは1つ、作成は Dashboard | ✅ | 条件は `and` / `or` で組み合わせ可、制御は1ルールに1つ。**ルール一覧・作成の API はリファレンスに無い**（`/api/v2/core/approval-rules` は 404）。`status` はルール名を承認リクエストの `rule.name` から間接的に表示する |
| 5 | 14日で自動 expired | ✅ | ガイドに明記。リファレンスのサンプルは `expires_at` が作成の7日後（サンプル値と思われる）。実値は B-2 で記録 |
| 6 | restricted key 作成時に「Authorizing agent access to your account」で agent タグ | ✅ | secret key には付かない。**agent タグの有無を API で判別する方法は記載なし** → `status` は rk_ なら「判別不可」、sk_ なら「agent タグ無し」と表示 |
| 7 | デフォルトルールの記述がページ間で不一致 | ✅ | Approvals: 返金の作成・サブスクの解約 / API keys:「payouts, refunds, and account configuration changes」（初めて agent キーを作ったときに付与）→ B-7 |
| 8 | MCP は 2026-11-30 までに移行、12月以降 agent タグ無しキーは 401。OAuth 経由は確認URL → approval token → 再実行、24時間 | ✅ | 401 には OAuth discovery challenge が付く。**MCP の Supported API methods に Create refund はあるが、クレジットノート・顧客残高取引は無い** → M10 は返金だけで比較 |
| 9 | x402 は PaymentIntent として記録、返金は通常の返金。preview。米国外は machine-payments@stripe.com | ✅ | 追加の前提: Dashboard > Payment methods で「Stablecoins and Crypto」をリクエストし、承認されると有効になる。sandbox は Base Sepolia + 公開 facilitator、deposit address 作成は `2026-07-29.preview`、PaymentIntent の作成は `2026-05-27.preview` で `transaction_verification`（**決済済みのオンチェーン tx hash が必要** = テストネットの USDC を入れたウォレットが要る） |

### その他、ドキュメントから実装に反映したこと

- approval request の `status` は `requires_review` / `approved` / `succeeded` / `failed` / `rejected` / `canceled` / `expired`
  （`pending` / `execution_*` は deprecated 扱い）。`status` コマンドは deprecated 名も集計に含める。
- 実行結果は `status_details.succeeded.result.{id,object}`（deprecated の `execution_succeeded.result` も読む）。
  webhook は `succeeded` で approval request を取得し、起案したアクションと実行結果のオブジェクトの種類が
  一致するかを確かめる。
- `POST /v2/core/approval_requests/{id}/cancel` がある → B-5 の `canceled` を cancel API で作れる。
- update のエラーコード: 400 `approval_expired` / 403 `not_authorized` / 404 `approval_request_not_found` /
  409 `invalid_status_transition`。
- ID の接頭辞はガイドが `apreq_`、リファレンスが `areq_`。コードは接頭辞に依存しない。
- 単一メンバーのアカウントでは actor 条件が `agent-tagged API keys` のルールだけ保存できる。

---

## 2. ライブで確認したこと

### 環境の状態

| 日付 | 内容 |
|---|---|
| 2026-10-20 | この開発環境には Stripe のキーが無い（`STRIPE_*` 未設定）。`api.stripe.com` / `mcp.stripe.com` / `docs.stripe.com` への通信は可能（M0 時点の 403 遮断は解消）。 |
| 2026-10-20 | **キー無しの観測のみ**: `POST https://mcp.stripe.com`（initialize）→ `HTTP 401`、`www-authenticate: Bearer resource_metadata="https://mcp.stripe.com/.well-known/oauth-protected-resource"`。12月以降に agent タグ無しキーが受ける 401 と同じ形の challenge と思われるが、キー付きでは未確認。 |
| 2026-10-20 | 実装はローカルのモック（`STRIPE_API_BASE_URL` / `STRIPE_MCP_URL` を差し替え）で分岐を確認した: approval_required → update（`/update` 404 → `/{id}` へのフォールバック）、Block と Stripe 自身の 429 の区別、MCP の SSE 応答、cancel、webhook の succeeded 処理。**モックの形はドキュメントからの想定であり、ライブ確認ではない。** |

### 検証項目

各項目は本人の Dashboard 操作が済んだ後に CC が流して追記する。

| # | 項目 | 状態 | 流すコマンド |
|---|---|---|---|
| B-0 | Settings > Approvals が出ているか（public preview 化で登録不要になったか） | ✅ 2026-10-21 | 本人のスクショで確認（下の記録） |
| B-2 | approval_required の形 | ✅ 2026-10-24（差分あり） | `npm run propose -- --only=INQ-001` → `npm run evidence -- --outcome=approval_required --last=1` |
| B-4 | update（`2026-09-30.preview`）の要求/応答、通ったパス | ✅ 2026-10-24（`/{id}` が正、`/update` は 404） | `npm run evidence -- --kind=approval_update --last=1` |
| B-5 | webhook 7種（expired は cancel の canceled で代替） | 5種 ✅（created / approved / succeeded / canceled は配送、rejected は events API）。expired は expires_at 経過後も未発生（確認中）、failed 未実施 | `npm run webhook` + `stripe listen` の状態で承認・却下・`npm run approvals:cancel` |
| B-6 | クレジットノートのルールで approval_required が返るか | ✅ 2026-10-25（`credit_note.create`） | `npm run propose -- --only=INQ-004` |
| B-7 | デフォルトルールの実際の中身 | ✅ 2026-10-21 / 更新 2026-10-24（アカウントにより2件または3件） | 本人のスクショで確認（下の記録） |
| B-9 | Block 時のエラーの形 | ✅ 2026-10-25（403 `action_blocked`） | `npm run demo:runaway -- --count=5 --interval=10 --rule-set=block` → `npm run evidence -- --outcome=blocked`（未分類なら `--outcome=error`） |
| B-10 | x402 の返金が返金ルールに掛かるか | ⛔ | M11 停止中（§3） |
| M10 | CLI / MCP 経路の差 | ✅ 2026-10-27（どちらも Approvals に乗る。MCP は Markdown 応答） | `npm run demo:mcp -- --amount=1500` → `logs/route-compare.jsonl` |

### B-0 / B-7（2026-10-21、本人の Dashboard スクショ）

対象: sandbox「x402」（Test mode）、Settings > Approvals > Rules。API は叩いていない（キー未設定）ので生レスポンスは無い。

- **B-0 ✅**: Settings > Approvals（Rules / Requests タブ、Create rule ボタン）が表示される。
  `approvals_product_preview` への個別登録の有無はこの画面からは分からないが、少なくともこの sandbox では使える状態。
- **B-7 ✅**: Stripe が入れたルールは2件だけ（Last author = Stripe、作成 2026-10-21 5:29 PM、どちらも Active）。
  | Rule name | 条件 | 制御（画面の表記） | Reviewers |
  |---|---|---|---|
  | Refund created | Actor equal to Agent key | Submit for approval | Analyst +2 more（ロール指定） |
  | Subscription canceled | Actor equal to Agent key | Submit for approval | Analyst +2 more（ロール指定） |

  payouts・アカウント設定変更のルールは**入っていない**。→ Approvals ページの記述（返金の作成・サブスクの解約）が正しく、
  API keys ページの記述（payouts, refunds, account configuration changes）とは一致しない。
- 画面の表記とドキュメントの対応: 制御「**Submit for approval**」= ドキュメントの「Require approval」。Actor の値は「**Agent key**」
  （ドキュメントは「agent-tagged API keys」）。
- メンバー1人のアカウントでは条件の画面に注記が出る:「You're the only user on this account, so approval rules can only apply to
  requests made with an agent key.」（ドキュメントの「Accounts with a single team member」と一致）
- **デモに効く点**: デフォルト2件のレビュアーはロール指定（Analyst +2 more）。ドキュメント上メール通知は個人指定のメンバーにしか
  届かないため、デフォルト2件にも本人を個人として追加する必要がある。
- 作成日時がルール作成の起点（初めての agent キー作成）と思われるが、キー一覧は未確認。

### 2026-10-24 — 最初のライブ実行: 返金がゲートされずに実行された

環境: sandbox `x402 sandbox`（acct_1TzQ…、country JP）。`STRIPE_SECRET_KEY` = sk_test_…、`STRIPE_AGENT_KEY` = rk_test_…00ay。
Stripe CLI 1.55.1 の `stripe listen` が表示したアカウント既定の API バージョンは `2026-07-29.dahlia`。

| 時刻 (UTC) | 操作 | 結果 |
|---|---|---|
| 06:27 | `GET /v2/core/approval_requests`（secret key、`2026-09-30.preview`） | HTTP 200、`{"data":[],"next_page_url":null,"previous_page_url":null}` → **list endpoint とこの preview バージョンはライブで通る** |
| 06:27 | `npm run seed` | 顧客4・サブスク3・charge 4（プール含む）・open 請求書 1 を作成。正常 |
| 06:28 | INQ-001 返金 ¥3,300（agent key、`2025-02-24.acacia`） | **HTTP 200 で即時実行**（re_3UTyQQ…、Request-Id `req_fbcO7mGmv44Iyh`）。approval_required は返らない → `rule_not_enforced` |
| 06:28 | 切り分け: プールから返金 ¥1,500（agent key、`Stripe-Version: 2026-07-29.dahlia`） | **HTTP 200 で即時実行**（re_3UTyQT…、Request-Id `req_75CsqgM2f2SVOf`）→ API バージョンは原因ではない |
| 06:28 | 切り分け: 両キーの所属アカウント | 同じ acct_1TzQ…（agent key は `/v1/account` の権限が無く、エラー本文に同じアカウント ID が出る） |
| 06:28 | `GET /v2/core/approval_requests`（agent key） | HTTP 200、`data: []` → agent key は approval request を読める |

この時点で Dashboard 上の Refund created（Actor = Agent key、Submit for approval）は Active（2026-10-21 のスクショ）。
**有力な原因: `STRIPE_AGENT_KEY` に入っているキーに Agent タグが付いていない**（API では判別できないため Dashboard で確認待ち）。
他の候補: ルールが編集途中で保存されていない／無効化されている。

### 2026-10-24 — デフォルトルール作成後: ゲートが効いた（B-2 / B-4 / B-5 / B-7 更新）

- **07:54 UTC（Dashboard 表示 Oct 24, 4:54 PM）**、`x402 sandbox` に Stripe 作成のルールが **3件**できた（本人のスクショ）:
  Subscription canceled / **Payout created** / Refund created（いずれも Active、レビュアー Analyst +2 more）。
  06:28 の時点ではこのアカウントにルールが無く、そのため返金が素通りしたと考えられる。
  2026-10-21 のスクショは別の sandbox（「x402」）で、そちらは2件（Payout created なし）。
  → **B-7 の更新: デフォルトルールはアカウントによって2件のことも3件のこともある**。3件の方は API keys ページの記述
  （payouts, refunds, …）に近い。何をきっかけに作られたかは未確認。
- 同じキー（rk_test_…00ay）で返金を起案すると、**ゲートが効いた**。

#### B-2 approval_required の形 ✅（ドキュメントと差分あり）

07:55 UTC、プールから ¥1,500 返金、`Stripe-Version: 2025-02-24.acacia`、Request-Id `req_zGKRleeIZ9GCq3`:

```json
HTTP 403
{
  "error": {
    "approval_request_id": "apreq_test_61VdNkpeKUd05uNew16V8o4HBpHNq7Aqs1lswdSZsLyK",
    "code": "approval_required",
    "doc_url": "https://stripe.com/docs/error-codes/approval-required",
    "message": "This action requires human approval before it can be completed. An approval request has been created and is awaiting review. If approved, it will automatically execute. To check status: GET /v2/core/approval_requests/apreq_test_…. To provide context for the reviewer: POST /v2/core/approval_requests/apreq_test_… with a reason parameter. These endpoints require API version 2026-08-26.preview or later.",
    "request_log_url": "https://dashboard.stripe.com/acct_1TzQ…/test/workbench/logs?object=req_zGKRleeIZ9GCq3",
    "type": "invalid_request_error"
  }
}
```

- HTTP は **403**。id は**フラットな `error.approval_request_id`**。想定していた `error.approval_request.{id,action,status,dashboard_url,expires_at}`
  の**オブジェクトは無い** → パーサを両方受け付けるよう修正し、action / status / dashboard_url / expires_at は update の応答から埋める。
- ID 接頭辞は `apreq_test_`。古い API バージョン（acacia）でもゲートは効く。

#### B-4 理由文 update ✅（ドキュメントと差分あり）

- `POST /v2/core/approval_requests/{id}/update`（ガイドのパス）→ **HTTP 404**
- `POST /v2/core/approval_requests/{id}`（API リファレンスのパス、エラーメッセージの案内とも一致）→ **HTTP 200**
- `Stripe-Version: 2026-09-30.preview` で通る。応答は approval request オブジェクト（`action: "refund.create"`, `status: "requires_review"`,
  `dashboard_url: https://dashboard.stripe.com/acct_…/test/settings/approvals/requests/apreq_test_…`）。
- **`expires_at` は作成の24時間後**（2026-10-25T07:55:23Z）。ガイドの「14日で失効」とは違う（sandbox だけの挙動かは未確認）。
  → **承認は起案から24時間以内に押す必要がある**。

#### B-5 webhook ✅（一部）

- `canceled`: `npm run approvals:cancel` → `v2.core.approval_request.canceled`（evt_test_65VdNloh…）が `stripe listen` 経由で届き、監査ログに反映。
- `created`: 4件届いた。ただし**起案と同じ秒に届き、監査ログ書き込みより先に着く**ため、webhook が記録を見つけられず捨てていた
  → 最大6秒待って再確認するよう修正。
- approved / rejected / succeeded / failed: 本人の承認・却下の後に確認する。expired は24時間で起きるはずなので、放置した1件で確認できる見込み。

### 2026-10-24 — 本人の承認・却下の結果（B-5 続き）

本人が 09:51 UTC に Dashboard で操作。その時点でコンテナが再起動しており、`stripe listen` と webhook サーバーは止まっていた
（イベントは手元に届いていない）。`GET /v2/core/events`（secret key）で発行を確認し、`npm run reconcile` で監査ログに反映した。

| fixture | 操作 | 発行されたイベント（GET /v2/core/events） | 最終状態 / 実行結果 |
|---|---|---|---|
| INQ-005 解約 | 承認 | `approved` 09:51:07 → `succeeded` 09:51:08（同時に v1 `customer.subscription.deleted`） | succeeded / `subscription` sub_1UTyQI… |
| INQ-003 返金 ¥5,000 | 却下 | `rejected` 09:51:11 | rejected（返金なし） |
| INQ-002 返金 ¥80,000 | 承認 | `approved` 09:51:14 → `succeeded` 09:51:15（v1 `refund.created`） | succeeded / `refund` re_3UTyQR… |
| INQ-001 返金 ¥3,300 | 承認 | `approved` 09:51:17 → `succeeded` 09:51:18（v1 `refund.created`） | succeeded / `refund` re_3UTzoo… |

- 承認から実行まで約1秒。`approved` と `succeeded` は別イベントとして出る（ドキュメントどおり）。
- **解約の action 名は `subscription.update`**（cancel ではない）。
- **approval request の取得・一覧は起案したキーでしかできない**: secret key で retrieve すると
  403 相当の `not_authorized`「Only the API key that created this request can perform this action.」、list は 0 件。
  agent key では5件すべて見える → retrieve / list の既定キーを agent key に変更。
- 各リクエストの `rule.name` は Refund created / Subscription canceled（デフォルトルール名）。
- B-5 の残り: `failed`（未発生）、`expired`（24時間で起きる見込み）。7種のうち created / approved / rejected / canceled / succeeded の
  5種の発行を確認（approved / rejected / succeeded は配送ではなく events API での確認）。
- 監査ログに INQ-001 の `rule_not_enforced` が残るのは 06:28 のルール作成前の実行分。

### 2026-10-24 15:37 UTC — INQ-004 クレジットノート（B-6）: 権限不足で拒否

本人が Credit note is created（Actor = Agent key、Submit for approval、レビュアー個人指定）を Activate した後に起案。

- HTTP 403 `more_permissions_required`「…does not have the required permissions… Enabling Credit Notes Write ('credit_note_write')
  permissions on this key would allow this request to continue.」（Request-Id `req_WqYXhMrg1HiFM0`）
- → **キーの権限チェックは承認ルールより先**。権限が無ければ approval request は作られない。B-6 は権限追加後に再実行。

### 2026-10-25 11:37 UTC — INQ-004 クレジットノート（B-6）✅

本人がキーに Credit Notes Write を追加した後に再実行。

- `POST /v1/credit_notes`（open 請求書 ¥30,000 に対し ¥15,000、custom line item）→ **HTTP 403 `approval_required`**（Request-Id `req_9XqRkJ2DyAz5F9`）。
  返金と同じ形（フラットな `error.approval_request_id`）。
- approval request: **`action: "credit_note.create"`**、`status: requires_review`、`rule.name: "Credit note is created"`、
  `requested_by: {type: "api_key", api_key: {id: "mk_…", name: "x402"}}`、`expires_at` は作成の24時間後。
- → **ガイドの Supported actions どおり、クレジットノートは承認対象**。API リファレンスの `action` enum に
  `credit_note.create` が無いのはリファレンス側の記載漏れ。
- `requested_by.api_key.id` は `mk_…` 形式（キーのトークン `rk_test_…` ではなく、Dashboard 上のキー ID。キー編集 URL の id と一致）。
- webhook: `created` を記録できた（2026-10-24 の取りこぼし修正が有効）。

### 2026-10-25 11:39 UTC — INQ-004 承認 → 実行（webhook 経由で全段を受信）

- `stripe listen` + webhook サーバー稼働中に本人が承認。`created`（11:37:09）→ `approved`（11:39:28）→ `succeeded`（11:39:29）が
  **すべて webhook で配送され**、監査ログに反映。succeeded で approval request を agent key で取得し、
  `status_details.succeeded.result` = `credit_note` cn_1UUP… を記録（起案アクションと一致）。
- B-5: approved / succeeded も配送で確認できた。7種中 created / approved / rejected（events API）/ canceled / succeeded を確認、
  failed・expired は未発生。
- Block 版ルール作成時の画面: 単一メンバーのアカウントでは条件の先頭「Actor equal to Agent key」は**変更不可**。
  rate limit は「Add condition」で追加する形（本人の画面で確認中）。

### 2026-10-25 11:56 UTC — M9 暴走シナリオ Block 版（B-9）✅

ルール構成（本人の Dashboard 操作）: デフォルトの Refund created を **Inactive**、新規「Refund is created」を **Active**
（条件 `Actor equal to Agent key` **And** `Number of requests exceeds`（3件 / 10分のつもりで設定）、制御 **Block**、レビュアーなし）。

- 画面の表記: rate limit 条件は「**Number of requests exceeds**」。Add condition で選べるのは **Amount** と **Number of requests exceeds** の2つだけ。
  単一メンバーのアカウントでは先頭の Actor 条件は変更できず、追加条件は And でつながる。
- 同じトリガーのルールを2つ同時に Activate しようとすると「A rule for the same trigger is already active. Deactivate it before activating
  this one.」で拒否される（ドキュメントの「Only one active rule can apply to a given action」の実際の挙動）。

`npm run demo:runaway -- --count=5 --interval=10 --amount=1500 --rule-set=block`（run `runaway-20261025115637`）:

| # | 経過 | HTTP | 結果 |
|---|---|---|---|
| 1 | +1s | 200 | 即時実行 re_3UTyQT…mshY2MD |
| 2 | +12s | 200 | 即時実行 re_3UTyQT…8Rv4RSK |
| 3 | +23s | 200 | 即時実行 re_3UTyQT…NdIWWJv |
| 4 | +33s | 403 | **Block** |
| 5 | +44s | 403 | **Block**（Request-Id `req_8TvZoEgvPm6P1x`） |

Block の生レスポンス（#5）:

```json
HTTP 403
{
  "error": {
    "code": "action_blocked",
    "doc_url": "https://stripe.com/docs/error-codes/action-blocked",
    "message": "This action is blocked by an approval rule on your account. To allow this action, modify or remove the rule in the Dashboard under **Settings** > **Approval Rules**.",
    "request_log_url": "https://dashboard.stripe.com/acct_1TzQ…/test/workbench/logs?object=req_8TvZoEgvPm6P1x",
    "type": "invalid_request_error"
  }
}
```

- **B-9 確定**: HTTP 403、`error.code = "action_blocked"`、`type = invalid_request_error`。エラーに approval_request_id は**付かない**。
  実装の判定（code に "block" を含む）はそのまま当たった。
- **ただし approval request は作られる**（当初「作られない」と書いたのは誤り、同日訂正）: Block された #4・#5 と同時刻に、
  agent key の一覧へ `status: "rejected"`、`review: null`、`status_transitions: null`、`reason: null`、`rule.name: "Refund is created"`
  の approval request が2件増えた（apreq_test_61Vdo0MA…、apreq_test_61Vdo0W7…）。
- これらについて `v2.core.approval_request.*` イベントは**発行されない**（`GET /v2/core/events` に無し。同時刻の v1 イベントは
  #1〜#3 の refund 関連だけ）。→ Block は webhook では検知できず、API 応答（403 `action_blocked`）か一覧でしか分からない。
- 一覧上は人間の却下と同じ `rejected` になる。区別するには `review` が null か（人間の却下は `review.result = "rejected"`）を見る。
- 「3件を超えたら」の数え方は想定どおり（3件目までは通り、4件目から拒否）。

### 2026-10-27 14:10 UTC — M9 承認版: 同じ対象への承認待ちは1件まで

ルール: Block 版を Inactive、デフォルト Refund created を Active に戻した後。

`npm run demo:runaway -- --count=5 --interval=10 --amount=1500 --rule-set=approval`（同じプール PaymentIntent への部分返金を5回）:

| # | HTTP | 結果 |
|---|---|---|
| 1 | 403 | approval_required（apreq_test_61VeZ1zY…） |
| 2〜5 | **400** | `{"error":{"message":"There is already an approval request waiting to be reviewed by an administrator for this action.","type":"invalid_request_error"}}`（**code なし**、Request-Id 例 `req_jYH4kOUXVzmQBa`） |

- 範囲の切り分け:
  - 同じ PaymentIntent・別の金額（¥1,600）→ 同じ 400
  - **同じ顧客の別 PaymentIntent**（INQ-003、suzuki-month）→ approval_required（新しい承認待ち）
  - 2026-10-24 には別顧客の返金3件が同時に承認待ちになれた
  - → **承認待ちの重複チェックは対象 PaymentIntent 単位**（顧客単位・アクション単位ではない）
- 暴走の観点: 同じ支払いへの連打は、承認待ち1件に**自然に集約**される（Block ルールが無くても2件目以降は 400）。
  別々の支払いへの連打は止まらないので、rate limit + Block はそちらに効く。
- 実装: この 400 を `duplicate_pending` として分類するようにした。M10 は経路ごとに別の charge（route-cli / route-mcp）を使うよう変更。
- INQ-003 の承認待ち（apreq_test_61VeZ35l…、expires_at 2026-10-28T14:11:08Z）は **expired 確認用にあえて放置**。

### 2026-10-27 14:12 UTC — M10 経路比較 ✅

| | 直接 API（CLI） | Stripe MCP（agent key を Bearer） |
|---|---|---|
| 接続 | — | `initialize` 成功（serverInfo `stripe-mcp 1.0.0`）、tools 9個 |
| 返金の呼び方 | `POST /v1/refunds` | `stripe_api_write`（`stripe_api_operation_id: "PostRefunds"`, `parameters: {payment_intent, amount, metadata}`） |
| 応答 | HTTP 403 JSON `error.code=approval_required`、`error.approval_request_id` | tool result `isError: true`、**Markdown テキスト**:「This action requires human approval … **Approval Request**: apreq_… **Approval URL**: (Dashboard の Approvals Requests ページ)」。次の手順として理由文を `PostV2CoreApprovalRequestsId` で付けるよう指示（reason は最大1000文字、「ユーザーに書かせず自分で書け」） |
| approval_required | yes | yes |
| approval request の作成 | あり（apreq_test_61VeZ46k…、rule `Refund created`） | あり（apreq_test_61VeZ5PM…、rule `Refund created`、`requested_by` は同じ mk_… / "x402"） |
| 理由文の付与 | `POST /v2/core/approval_requests/{id}`（直接） | MCP `stripe_api_write` `PostV2CoreApprovalRequestsId` → 応答 `structuredContent` に approval request オブジェクト（JSON） |
| 確認URL（OAuth 経路の approval token 方式） | なし | **なし**。返る URL は Approvals の Requests ページ（承認は Dashboard、approval token は出ない） |

- `stripe_api_write` の入力スキーマ（2026-10-27）: `stripe_api_operation_id`（必須）/ `parameters` / `human_confirmation.approval_token`。
  `human_confirmation` の説明は OAuth 経路の「確認URL → 人間が承認 → approval_token を付けて再実行」の手順で、ドキュメントの記述と一致。
  agent key ではこの経路にならず、Approvals 側に乗る。
- 最初の実行では実装がスキーマ（operation id 形式）と Markdown 応答に未対応で失敗 → 対応後に再実行。途中で作られた理由なしの
  承認待ち（apreq_test_61VeZ4ZA…）は cancel 済み。

### 2026-10-27〜28 — RUNAWAY#1 / ROUTE-CLI / ROUTE-MCP の結果

計画では3件とも却下の予定だったが、Dashboard 上の操作の結果は **3件とも承認** → Stripe が自動実行し succeeded
（`npm run reconcile` で反映。webhook パイプラインは操作時に停止していた）。

| fixture | 経路 | 結果 | 実行結果 |
|---|---|---|---|
| RUNAWAY#1 | cli | approved → succeeded | refund re_3UTyQT…rDpZ0CQ（プールから ¥1,500） |
| ROUTE-CLI | cli | approved → succeeded | refund re_3UVB6f…BnExMTj（route-cli から ¥1,500） |
| ROUTE-MCP | mcp | approved → succeeded | refund re_3UVB6f…YYDymwQ（route-mcp から ¥1,500） |

- MCP 経路で起案し MCP で理由文を付けた承認リクエストも、承認後は直接 API 経路と同じく Stripe が実行する（経路による差なし）。
- sandbox のテストデータの消費のみ。route-cli / route-mcp は `npm run seed` で補充される。

### 2026-10-28 14:25 UTC — expired の確認（1回目）: expires_at を過ぎても失効しない

- INQ-003 の承認待ち（apreq_test_61VeZ35l…、`expires_at: 2026-10-28T14:11:07Z`）を、期限の約14分後に agent key で取得
  → **`status: requires_review` のまま**（status_transitions null、review null）。
- `GET /v2/core/events` に `v2.core.approval_request.expired` は**出ていない**。
- 解釈の候補: (a) 失効処理がバッチで遅れて走る、(b) `expires_at`（作成+24時間）の値と実際の失効（ガイドの14日）が一致していない。
  → 2026-10-28 20:30 UTC に再確認。それでも失効していなければ、ガイドの14日（2026-11-10 14:11 UTC 頃）で再確認する。

### 2026-10-28 20:30 UTC — expired の確認（2回目）: まだ失効しない

- INQ-003 の承認待ちは `expires_at`（14:11:07Z）から約6時間20分後も **`requires_review`**。`v2.core.approval_request.expired` イベントも無し。
- → 「作成+24時間」の `expires_at` は実際の失効時刻ではない可能性が高い。ガイドの14日（2026-11-10 14:11 UTC 頃）で再確認する。
- README の「承認期限は24時間」は、`expires_at` の値の観測としては正しいが、**期限を過ぎても承認待ちのまま残る**ことを併記する。

### 追記の書式

```
### B-x（YYYY-MM-DD）
- Stripe-Version: v1 2025-02-24.acacia / v2 2026-09-30.preview
- 結果: ✅ / ⚠️（ドキュメントとの差分を1行で）
- 生レスポンス（npm run evidence の出力を貼る）
```

---

## 3. M11（x402 で受けた支払いの返金）— ⛔ 停止中

- 停止理由: このアカウントで machine payments（ステーブルコイン決済）が使えることを確認できていない。
  2026-10-20 時点でこの環境に Stripe キーが無く、`npm run x402:check` を流せない。fixture が JPY であることから
  米国外（日本）のアカウントと見込まれ、その場合は machine-payments@stripe.com への申請が必要。
- 実装済み: 利用可否の確認だけ（`npm run x402:check`。アカウントの国、payment method configuration の
  `crypto` の可否、任意で deposit address の作成を試す）。
- 再開の条件: `npm run x402:check` が「利用可能」を返すこと。
- 再開後にやること: sandbox で Base Sepolia の deposit address を作成 → テストネット USDC で x402 の支払いを1件通し、
  PaymentIntent（`transaction_verification`）として記録 →「データが届かなかった」想定の返金を、PaymentIntent ID・
  リクエストURL・HTTP ステータスを理由文に入れて起案 → 承認 → succeeded まで既存と同じログ形式で残す → B-10。
