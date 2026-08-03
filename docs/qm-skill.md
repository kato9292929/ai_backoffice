# 第二成果物: qm 用 Stripe Approvals スキル

主成果物（スクラッチ CLI デモ）と同じ主張を、実運用 OSS 基盤 **qm**（yc-software/qm, MIT）の
上で成立させるための薄いレイヤー一式。qm 本体は改変しない（core は byte-identical のまま）。
根拠として引用する行番号は `docs/qm-evaluation.md`（commit `b5f3c0e`）調査時点の qm checkout に対する
repo 相対。読んで確定できなかった点は「未確認」として残す。

このディレクトリの成果物（`qm-layer/`）は、実際の qm 私有フォークの
`deploy/layers/<org>/` に丸ごとコピーして使うことを想定した移植バンドル。ここ（ai_backoffice）
では qm フォークを持たないため、レイアウトだけ再現して置いている。`<org>` は実在 slug を勝手に
決めず、プレースホルダのままにしている。

---

## この成果物が示すこと

主成果物が示すのは「Stripe の二者承認の上に AI 起案層を作れる」こと。第二成果物が示すのは
**「実運用 OSS 基盤に構造的に無い四眼分離を、Stripe 公式機能で埋められる」**こと。

qm の承認は、**クリックした人が依頼者本人でないと弾かれる**実装になっている
（`src/slack/approvals.ts:560-572`「Only the person who requested this command can approve
or deny it.」）。通常会話では core は承認者==起案者を独立検証せずセッション一致のみ確認する
（`src/core/orchestrator.ts:1314`）。SECURITY.md 自身も command policy を「bypassable な speed
bump」と位置づけている（SECURITY.md:88-91）。つまり **qm には four-eyes（起案者≠承認者）が無い。**
本スキルはその穴を Stripe Approvals で埋める。Stripe から見た起案者は agent-tagged key、承認者は
Dashboard の人間で、両者は Stripe 側で別 principal として扱われるため、qm の identity が
人間限定（`src/types.ts:3,12`）でも分離は成立する。

---

## 構成図

```
Slack/web の問い合わせ
      │
      ▼
 qm のモデル（起案ロジックはここ。自前 planner は持ち込まない）
      │  SKILL.md「stripe-approvals」の手順に従う
      ▼
 execute → curl → core credential broker (/v1/credentials/broker)
      │      （Stripe key はサービス資格情報。エージェントは中身を見ない）
      ▼
 Stripe API ──▶ approval_required（error.approval_request: id / dashboard_url / expires_at）
      │           ← gated アクションは実行されない
      ▼
 broker 経由 POST /v2/core/approval_requests/{id}/submit  （理由文=reason, preview版ヘッダ）
      │
      ├─▶ ここまでの tool_call/tool_result は qm の durable transcript に載る（二重記録しない）
      │
      ▼
 Stripe Dashboard > Requests ── 別の人間が承認/却下 ──┐
      │  承認後は Stripe がアクションを自動実行         │
      ▼                                               ▼
 Stripe webhook (v2.core.approval_request.*) ─▶ S4 durable sink（Postgres）
   approved / succeeded / rejected / canceled / failed  ← ターン外の状態遷移を記録
```

## S1〜S4 の対応

| 部品 | 置き場所 | 役割 |
|---|---|---|
| **S1 スキル** | `qm-layer/sandbox/skills/stripe-approvals/SKILL.md` | `execute` の curl で Stripe を叩き、`approval_required`→submit まで案内。理由文は主成果物の8項目を流用 |
| **S2 資格情報** | 運用手順（下記）＋ `qm-layer/README.md` | Stripe key を org サービス資格情報として broker で供給。`VAULT_TOKEN_*` 代替も併記 |
| **S3 command policy** | `qm-layer/command-policy.stripe.json` | posture=auto のまま、金が動く curl だけ `require_approval`。ローカル速度バンプ |
| **S4 durable sink** | `qm-layer/plugins/stripe-approvals-sink/` | 承認後の非同期状態遷移を Postgres に記録（唯一の新規実装点） |

---

## S2 の要点 — Stripe key の供給と「broker 1個」制約の正体

**Stripe key は「サービス資格情報（service credential）」として持たせる。** これは org スコープ所有・
slug 参照・host/method/path 固定の共有資格情報で、`use-shared-credential` スキルと同じ
`/v1/credentials/broker` 経由で使う（`skills-seed/use-shared-credential/SKILL.md:22-33`,
`src/api/credential-broker.ts:90-137`）。エージェントは秘密を見ない。

**調査時の「broker は1デプロイ1つ」という制約は、Stripe には当たらない。** 精査した結果:

- 「1デプロイ1つ」の制約は、**レイヤー tool descriptor の `auth.broker`（`kind: "aws-role"`）**に対するもの
  （`src/deployment/load-layer.ts:80-83`, `src/deployment/deployment-layer.ts:245`）。これは AWS IAM
  ロールを ambient に vend する仕組みで、Stripe のような bearer key 用ではない。
- Stripe が使う **サービス資格情報の broker は別サブシステム**で、slug ごとに複数登録できる
  （`listServiceCredentials(orgScopeId)` が配列を返す, `src/credentials/keychain.ts:189`;
  `setServiceCredential` は slug キー, `:182`）。**個数上限は見当たらない（未確認: 明示的な上限の有無）。**

→ したがって Stripe を service credential として持たせる限り、「broker 1個」制約は回避策不要でぶつからない。
ただし org が**別途** `auth.broker: aws-role` のレイヤーツールを使う場合、そちらは 1 個制限がある点は
変わらない（Stripe とは無関係）。

**設定手順（運用）**: 管理者が Stripe test key をサービス資格情報として登録する。
`ServiceCredentialInput`（`keychain.ts:127-139`）に相当する値:

- slug: 任意（例 `stripe-test`）。エージェントの system prompt に host/method/path 付きで提示される
- host: `api.stripe.com`
- methods: `POST`, `DELETE`
- path prefixes: `/v1/refunds`, `/v1/invoiceitems`, `/v1/invoices`, `/v1/subscriptions/`,
  `/v1/customers/`, `/v2/core/approval_requests/`

**未確認**: 管理者がサービス資格情報を登録する具体的な admin UI/CLI/HTTP 経路は追跡していない
（`keychain.setServiceCredential` インタフェースは確認済み、`:182`）。

**代替（併記・未検証）**: per-scope の OAuth/デバイスフロー資格情報として `$VAULT_TOKEN_API_STRIPE_COM`
をサンドボックスに注入する経路（`skills-seed/linear/SKILL.md` パターン, 名前生成
`src/credentials/connector-token.ts:7`）。この経路の実サンドボックス env 注入の end-to-end は
**未確認**なので、採用する場合は未検証ラベルを残すこと。

---

## S3 の要点 — 選択的ゲートと数値比較の不在

- qm の command policy は**再構成したコマンドライン全体に対する大文字小文字無視の正規表現**で、
  posture 非依存に常時作動する（`src/policy/command-policy.ts:769-791`, 適用は
  `src/tools/primitives.ts:479-489,793-801`）。broker への curl は `-d '{...api.stripe.com/v1/refunds...}'`
  を含むので、URL がコマンド文字列として見え、マッチできる。
- **数値比較演算子は無い**。金額しきい値をやると正規表現リテラルになり脆いので、**しきい値は policy に
  寄せず Stripe のルール側に置く**。本成果物の command-policy ルールは「金が動くエンドポイントの存在」
  だけを見る。
- このルールは**レイヤー所有にできない**。レイヤーの tool `approvals` は自分のツールのバイナリ境界
  `\b<binary>\b` から始まらねばならず（`docs/deploy-directory.md` "Tool descriptors"）、core の `curl` を
  ゲートできない。よって S3 は**管理者がスコープの CommandPolicy に入れるルール**として提供する。
- このゲートの承認も**自己承認**（起案者が承認, `src/slack/approvals.ts:560`）。qm 側は速度バンプ、
  権威ゲートは Stripe、の整理を崩さない。

---

## S4 の要点 — 二重管理を避ける記録の分担

qm の記録は3系統: `audit_log`（粗い基盤アクション、JSON 列なし, `src/admin/postgres-audit-log.ts:22-35`）、
`run_activity`（ツールコール、JSONB だが **TTL 1時間で揮発**, `src/runs/postgres-run-activity-store.ts:30`）、
`session_entries`（durable transcript, `src/sessions/postgres-session-store.ts:172-175`）。

- **起案側は二重記録しない**: Stripe 呼び出しは `execute` の curl として走るため、`approval_required` の
  本文（`approval_request` id・`dashboard_url`）とリクエスト/レスポンスは tool_call/tool_result として
  qm の durable transcript に自然に載る。主成果物の JSONL 監査はここに持ち込まない。
- **承認後の状態遷移だけを sink が持つ**: `approved → succeeded` 等はターン外（Stripe→webhook）で起きる
  ため qm の受け皿が無い。S4 の sink（`stripe_approval_event` テーブル, append-only）が
  `approval_request` ID / `dashboard_url` / 状態遷移と受信時刻 / 最終結果を durable に記録する。
  transcript とは `approval_request` id で突き合わせられるので、監査は「起案=transcript / 承認後=sink」で
  一元化され、重複しない。
- sink は Postgres 直書き（`durable by default`, AGENTS.md:94-102 準拠）。in-memory リングバッファや
  JSONL のような揮発ストレージには要点を依存させない。

---

## 制約一覧（この成果物を運用する人が知っておくこと）

| 制約 | 出所 |
|---|---|
| qm に四眼分離が無い（承認者==起案者を強制/黙認）。分離は Stripe 側でのみ成立 | `src/slack/approvals.ts:560-572`, `src/core/orchestrator.ts:1314` |
| Stripe は service credential broker で供給。個数上限は無い（未確認: 明示上限） | `src/credentials/keychain.ts:189,182` |
| 「broker 1個/デプロイ」は aws-role レイヤーブローカーの話で Stripe には無関係 | `src/deployment/load-layer.ts:80-83`, `deployment-layer.ts:245` |
| command policy に数値比較なし（しきい値は正規表現リテラル）。金額条件は Stripe 側へ | `src/policy/command-policy.ts:769-791` |
| command policy はシェル経路のみ。非シェルツールは見ない。難読化で回避可 | `src/tools/primitives.ts:479-489`, SECURITY.md:88-91 |
| run_activity は TTL 1時間で揮発。durable な監査は transcript と S4 sink に置く | `src/runs/postgres-run-activity-store.ts:30` |
| ツール表面は固定で新ツールを足す口が無い。Stripe は execute 経由の curl のみ | `src/harness/pi-tools.ts:2397-2408` |
| egress は v1 で validated-only（強制ではない） | `docs/deploy-directory.md`（`sandbox.egress` VALIDATED-ONLY） |

---

## 未検証リスト（キーとネットワークがある環境で消化）

未消化を理由に本成果物の作成は止めていない。該当箇所にラベルを残し、想定外の挙動はフォールバックで
隠さず、生の envelope status/body を出して大きく失敗させる方針。

1. Stripe が agent-key の submit を「key の身元」と扱うか「key を作成した人間の身元」と扱うか
   （エージェント操作者が Stripe 承認者を兼ねられるかに直結。**ただし Dashboard 承認者を別人にすれば
   分離は成立するので設計ブロッカーではない**）。
2. `POST /v2/core/approval_requests/{id}/submit`（preview 版）と `approval_required` 本文の実挙動。
3. qm を実キー（モデルキー＋Stripe service credential）＋`api.stripe.com` への egress ありで
   end-to-end 起動して確認。
4. egress が validated-only である制約下で、Stripe スキルの宛先を `api.stripe.com` に固定できるか。
5. サービス資格情報を登録する管理者経路（admin UI/CLI/HTTP）の特定。
6. `VAULT_TOKEN_*`（per-scope）注入の実サンドボックス env end-to-end。

### 調査時点で読んで確定できなかった点（未確認のまま）

- published app の「per-app acting-as access」（SECURITY.md:65-67）が独立 principal を発行するか。
  `src/identity`/`src/auth` に非人間 `Principal` コンストラクタは見つからなかった。
- 非 Slack サーフェス（`src/api/user-scoped-routes.ts` 等）が独自の起案者==承認者チェックを持つか。
- `run_activity`/`session_entries` の payload の既存コンシューマが Stripe のカスタムキーを保持/表示するか。
