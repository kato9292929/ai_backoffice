# qm-layer — Stripe Approvals org layer (portable bundle)

移植バンドル。実際の qm 私有フォークの `deploy/layers/<org>/` に**このディレクトリの中身をコピー**して
使うことを想定している。ここ（ai_backoffice リポジトリ）は qm フォークではないため、レイアウトだけを
再現して置いている。設計の全体像・根拠・制約・未検証リストは [`../docs/qm-skill.md`](../docs/qm-skill.md)。

`<org>` は実在 slug を勝手に確定しない。フォークに置く段で `qm init deploy/layers/<org>` が生成する
`qm.config.jsonc` に統合する。

## 中身

```
qm-layer/
  sandbox/skills/stripe-approvals/SKILL.md   S1: execute+curl で Stripe を叩く起案スキル
  command-policy.stripe.json                 S3: 金が動く curl を require_approval にするスコープ規則
  plugins/stripe-approvals-sink/             S4: 承認後の非同期状態遷移を Postgres に記録する sink
    src/index.ts  schema.sql  package.json  tsconfig.json
  README.md                                  このファイル
```

主成果物側から意図的に**持ち込んでいない**もの（qm が代替するため）: 自前 planner、設定モジュール、
Node の HTTP クライアント、JSONL 監査、demo オーケストレーション。

## フォークへの載せ方（概略）

1. **スキル**: `sandbox/skills/stripe-approvals/` をフォークの
   `deploy/layers/<org>/sandbox/skills/` 配下へコピー。`qm up` が `PUT /v1/deployment-layer` で配信する。
2. **資格情報（S2）**: 管理者が Stripe test key を**サービス資格情報**として登録する
   （host `api.stripe.com`、methods `POST`/`DELETE`、path prefixes は `docs/qm-skill.md` の一覧）。
   エージェントの system prompt に slug が提示され、スキルはその slug を使う。個数上限は無い
   （「broker 1個/デプロイ」は aws-role レイヤーブローカー限定で Stripe には無関係。`docs/qm-skill.md` 参照）。
3. **command policy（S3）**: `command-policy.stripe.json` のルールを、対象スコープの CommandPolicy に
   管理者が追加する（レイヤー tool `approvals` はバイナリ境界に固定されるため core `curl` を直接ゲート
   できない。理由は `docs/qm-skill.md` §S3）。posture は `auto` のままでよい。
4. **sink（S4）**: `plugins/stripe-approvals-sink/` をフォークの `deploy/layers/<org>/plugins/` 配下へ
   置き、org サービスとしてデプロイ。`DATABASE_URL` と `STRIPE_WEBHOOK_SECRET` を与える。Stripe の
   webhook（`v2.core.approval_request.*`）をこの sink に転送する。

## sink をローカルで試す

```bash
cd plugins/stripe-approvals-sink
npm install
DATABASE_URL=postgres://... STRIPE_WEBHOOK_SECRET=whsec_... PORT=4245 npm start
# 別ターミナル: stripe listen --forward-to localhost:4245/webhook
```

`schema.sql` は起動時に冪等 DDL で適用される。`stripe_approval_event` は append-only、
`stripe_approval_latest` ビューが approval_request ごとの最新状態を返す。

## 禁止事項（この成果物のスコープ）

- qm core を改変しない（byte-identical を保つ）。ここは `deploy/layers/<org>/` 相当。
- 監査の要点を揮発ストレージ（run_activity は TTL 1h）に依存させない。durable は transcript と sink。
- qm 側の自己承認を四眼分離であるかのように書かない。権威ゲートは Stripe。
- `<org>` slug や資格情報 slug を推測で確定しない。
