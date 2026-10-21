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
| B-2 | approval_required の形 | ⏳ | `npm run propose -- --only=INQ-001` → `npm run evidence -- --outcome=approval_required --last=1` |
| B-4 | update（`2026-09-30.preview`）の要求/応答、通ったパス | ⏳ | `npm run evidence -- --kind=approval_update --last=1` |
| B-5 | webhook 7種（expired は cancel の canceled で代替） | ⏳ | `npm run webhook` + `stripe listen` の状態で承認・却下・`npm run approvals:cancel` |
| B-6 | クレジットノートのルールで approval_required が返るか | ⏳ | `npm run propose -- --only=INQ-004` |
| B-7 | デフォルトルールの実際の中身 | ✅ 2026-10-21 | 本人のスクショで確認（下の記録） |
| B-9 | Block 時のエラーの形 | ⏳ | `npm run demo:runaway -- --count=5 --interval=10 --rule-set=block` → `npm run evidence -- --outcome=blocked`（未分類なら `--outcome=error`） |
| B-10 | x402 の返金が返金ルールに掛かるか | ⛔ | M11 停止中（§3） |
| M10 | CLI / MCP 経路の差 | ⏳ | `npm run demo:mcp -- --amount=1500` → `logs/route-compare.jsonl` |

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
