# M0 — 環境確認レポート

対象アカウント / キーは**未提供**、かつ本実装を書いた実行環境は Stripe への
アウトバウンド接続が遮断されている（プロキシが `api.stripe.com` / `docs.stripe.com`
への CONNECT を 403 で拒否、Stripe CLI 未導入、Stripe キーの環境変数なし）。

そのため第2節チェックリストの **ライブ検証は本環境では実施できていない**。
各項目について「本環境で確認できたこと」「未確認のまま実装がどう振る舞うか」
「あなたの環境で確認する手順」を以下に明記する。コードは公開ドキュメント記載の
仕様に対して書いてあり、ライブ挙動が異なる場合は**黙って誤動作せず明示的に
エラー/警告を出す**ように防御的に実装している。

凡例: ✅ 確認済み / ⚠️ 本環境では未確認（要ライブ確認） / ❌ 不可

---

## チェックリスト

### 1. Stripe Approvals が対象アカウントで利用可能か（Settings > Approvals の有無）

- 状態: ⚠️ 未確認（アカウント未提供・ネットワーク遮断）
- 確認手順: Dashboard（test mode）> Settings > Approvals が表示されるか。
  無い場合はアカウントで機能が有効化されていない → Stripe に有効化を依頼。
- 依存する実装: 全体。Approvals が無いと `approval_required` が返らず、
  M3 の全 gated ケースが `rule_not_enforced`（警告）としてログに出る。
  → **迂回せず警告で気づける**設計。

### 2. Approvals がテストモードで動作するか（`apreq_test_...`）

- 状態: ⚠️ 未確認
- 確認手順: M2 のルールを1つ設定し、agent key で `POST /v1/refunds` を実行。
  返ってくる `error.approval_request.id` が `apreq_test_...` か確認する。
- 実装: `parseApprovalRequired()` は `error.code === 'approval_required'` または
  `error.approval_request` の存在で判定。id 接頭辞には依存していない。

### 3. agent-tagged API key を作成できるか

- 状態: ⚠️ 未確認（参照: https://docs.stripe.com/keys#agent-keys ）
- 確認手順: Dashboard > Developers > API keys で agent key を作成し、
  `STRIPE_AGENT_KEY` に設定。`config.ts` は test 接頭辞（`sk_test_`/`rk_test_`）
  以外を拒否する。
- 実装: seed は通常キー（`STRIPE_SECRET_KEY`）、起案は agent キー
  （`STRIPE_AGENT_KEY`）と明確に分離済み。

### 4. `Stripe-Version: 2026-07-29.preview` の `/v2/core/approval_requests/{id}/update` が公式 SDK でサポートされているか

> 訂正（現行ドキュメント）: 旧記述の `/submit` + `2026-06-24.preview` は現行版と異なる。
> `approval_required` が返ると Stripe が承認要求を**自動でレビューへ提出**する。理由文の
> 付与は `/submit` ではなく `POST /v2/core/approval_requests/{id}/update`、バージョンヘッダは
> `2026-07-29.preview`。「未提出は24時間で失効」は現行記述に見当たらない。

- 状態: ⚠️ 未確認。**素の HTTP クライアントで叩く方針を採用**。
- 判断: update は preview バージョン固定のため、安定版 typed SDK に依存せず
  `fetch` で直接呼ぶ（`updateApprovalRequest()`）。同様に、`approval_required`
  エラー本文を正確に読むため、起案アクションの v1 呼び出しも素の `fetch`
  （`agentRequest()`）で行う。
- 確認手順: update のレスポンス（HTTP ステータス / ボディ）を M3 実行時にログで確認。
  preview バージョンが更新された場合は `STRIPE_PREVIEW_VERSION` で差し替え可能。

### 5. Webhook で `v2.core.*` を受け取れるか（`stripe listen`）

- 状態: ⚠️ 未確認（Stripe CLI 未導入・ネットワーク遮断）
- 確認手順: `stripe listen --forward-to localhost:4242/webhook`。表示される
  `whsec_...` を `STRIPE_WEBHOOK_SECRET` に設定し、`npm run webhook` を起動。
- 実装: 署名検証は `Stripe.webhooks.signature.verifyHeader`（v2 thin event の
  スキーマ差異に依存しない低レベル API）で行い、本文は自前で JSON パース。
  approval_request id は `related_object.id` → `data.object.id` → `data.id`
  の順で防御的に取得。

### 6. Stripe agent skills / plugin（`stripe-docs`, `stripe-best-practices`）を導入できるか

- 状態: ❌ 本環境では不可（外部ネットワーク遮断のため取得・導入できない）。
  代替: 実装は公開ドキュメント記載の仕様に基づく。導入可能な環境では
  https://docs.stripe.com/skills の手順で入れてから運用すると良い。

---

## まとめ

- 本環境で**確認できた事実**: Node 22 / TypeScript で動作、`npm run typecheck`
  グリーン、起案エージェントの分類ロジックは6ケースすべて期待どおり
  （`create_refund` ×3 / `create_invoice` / `cancel_subscription` /
  `update_customer_metadata`）、監査ログの append-only 遷移（proposed →
  approved → succeeded=executed）が round-trip テストで通る。
- **未確認（要ライブ確認）**: 上記 1〜5 の Stripe ライブ挙動。あなたの環境で
  test キー・agent キー・`stripe listen` を用意して `npm run demo` を流すと、
  各項目のレスポンスがそのままログに出る。
- **不可**: 6（agent skills 導入）。

> 実装の各所に `UNVERIFIED against live Stripe` コメントを置いてあり、ライブ挙動が
> ドキュメントと食い違う箇所は、成功偽装せず HTTP ステータス/エラー本文を出す。
