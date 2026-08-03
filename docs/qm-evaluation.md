# 調査レポート: qm の identity 分離と Stripe Approvals 接続可否

対象: `yc-software/qm`（MIT）を、既存の Stripe Approvals デモの土台に載せ替えられるかの判断材料。
これは調査であり実装ではない。qm 本体の改変・デプロイ・Slack app 作成は行っていない。

**入手方法**: `git clone https://github.com/yc-software/qm`（成功）。以下の行番号は
その時点の checkout に対する repo 相対。読んで確定できなかった点は「未確認」と明記する。

---

## 0. 前提となる qm のモデル（3つだけ押さえる）

1. **identity は人間限定**。principal は `internal | guest`（どちらも人間）、scope は
   `personal | channel | team | org | group` の5種。エージェント専用の principal / scope は
   存在しない（`src/types.ts:3`, `src/types.ts:12`）。ターンの「誰として動くか」は常に人間の
   `actorId`（`src/identity/identity-service.ts:41-44,106-113`）。
2. **credential は非人間スコープに置ける**。org 所有の service credential（broker 型）を作れ、
   エージェントは使うが中身を見ない（`src/credentials/keychain.ts:546-566`）。
3. **ツール表面は固定**。`execute` がサンドボックス内でシェルを走らせる唯一の汎用実行口
   （`src/harness/pi-tools.ts:616/634/658`、README:65-66）。外部 API はスキルが指示する
   `curl` を `execute` で叩いて到達する。

この3点が、以下すべての回答の土台になる。

---

## 1. 最重要の確認事項 — identity 衝突は起きるか

### 結論（先に）

**衝突しない。ただし分離は qm 側ではなく Stripe 側で成立する。** qm の「エージェントは
その人として動く」は qm 内部の監査 identity の話。Stripe Approvals が「自分の起案を自分で
承認できない」と判定するのは **Stripe 側の principal**（起案した agent-tagged key と、
Dashboard にログインした人間の Stripe ユーザー）であり、qm の内部 `actorId` とは別物。
qm は Stripe の agent key を **org スコープの broker credential** として保持できるので、
「起案＝Stripe agent key の身元 / 承認＝Stripe Dashboard の人間」は qm 上でも作れる。

### 1-1. 外向きリクエストの身元 — 資格情報はどこから来るか

- **保管**: Core が持つ keychain（`src/credentials/keychain.ts`）。`kind: "env" | "file" | "broker"`
  （`keychain.ts:14,58-79`）、保存時暗号化（`secretEnc`, `keychain.ts:562`）。裏の secret source は
  環境変数と AWS Secrets Manager（`src/credentials/secret-source.ts:7,20,55`）。
- **サンドボックスへの供給（＝「その人として」動く解決点）**: `src/core/orchestrator.ts:951-986`。
  ターンごとに `keychain.materializeOwn(actor.id)` + `materializeStanding(scopeId)` を env として
  `sandbox.provision(...)` に渡す（`orchestrator.ts:955,963`, `src/core/orchestrator/sandboxes.ts:200-205`）。
  サンドボックス内では平文（SECURITY.md:96）。
- **egress の2経路**:
  1. **egress proxy**（`src/egress-authz-main.ts`）: サンドボックスが署名済み capability token を提示、
     ホスト allow/deny を強制、`principalId: claims.actorId`（人間）で監査（`:141-148`）。資格情報は注入しない。
  2. **credential broker**（`src/api/credential-broker.ts`）: `kind:"broker"` の秘密は**サンドボックスに入らない**。
     エージェントが Core の broker を呼ぶと、Core が org スコープの秘密を読み（`getServiceCredentialSecret(orgScopeId, slug)`,
     `:108`）、host/method/path を固定し、認証ヘッダをサーバ側で付与、`claims.actorId` で監査（`:90-96,119-137`）。
- **スコープ紐付け**: credential は本質的に個人固定ではなく **grant** で任意スコープに結ぶ。
  `KeychainGrant.audienceScopeId: ScopeId`（`keychain.ts:85-100`）で personal/channel/team/group/org の
  どれにも付けられる。service（broker）credential は org 所有（`keychain.ts:546-548`）で、ACL grant
  `"service-cred"` 経由でスコープに届く（`orchestrator.ts:1088-1095`, `src/acl/resource-ref.ts:1,13,20`）。

### 1-2. エージェント専用スコープ／サービスアカウントの可否

- **identity としては不可**。`PrincipalType = "internal" | "guest"`（`types.ts:3`）に非人間値なし。
  `SCOPE_KINDS`（`types.ts:12`）に `agent`/`service`/`bot` なし。`ActorAssertion.isBot?` はあるが
  bot 発言の抑制に使うだけで principal を作らない（`types.ts:422`, `src/slack/turn-handler.ts:229,239,430`）。
- **credential としては可能（＝サービスアカウント相当はここ）**。org レベル service credential
  （`setServiceCredential(orgScopeId, ...)` → `ownerId: orgScopeId`, `kind:"broker"`, host/method/path 固定,
  `keychain.ts:546-566`）。これが Stripe key を「人間ではない身元で」持たせる構造。file/OAuth 型も
  group/channel/team スコープ所有にできる（`src/credentials/device-flow-persist.ts:43-45`, `keychain.ts:908-922`）。
- **制約の在処**: acting principal は常に人間の `ActorAssertion.externalId` から解決され
  （`identity-service.ts:106-113`）、broker/materialize/監査すべて人間 `actorId` の下で動く
  （`orchestrator.ts:970,1043`, `credential-broker.ts:90-96`）。**非人間のエージェント identity を作る
  コード経路は存在しない**。

### 1-3. 承認者の分離 — qm の承認は誰が押すか

**qm の設計は「承認者＝起案者」。四眼原則（separation of duties）は無い。**

- Slack 面で**クリックした人＝元の依頼者**を強制。`src/slack/approvals.ts:560-572`:
  「Only the person who requested this command can approve or deny it.」他人が押すと拒否。
  つまり「自分の起案は自分で承認**する**」が唯一の正規モデルで、Stripe の逆。
- 通常会話では Core は承認者==起案者を独立検証しない。`orchestrator.ts:1314` はセッション一致のみ確認。
  承認 actor は source 認証されたサーフェスが主張（`src/api/routes/turns.ts:154` は `auth:"source"`,
  `src/api/app-turn.ts:58`）。`PendingApprovalRecord`（`types.ts:440-453`）に起案者フィールドは無い。
- Core が承認者==起案者を**強制する唯一の箇所**は managed project group
  （`src/api/app-turn.ts:256-270` → `approvalVisibleToViewer`, `src/api/app-helpers.ts:108`:
  `record.request?.actor.externalId !== viewer` を弾く）。
- 別機構として ask-agent handoff（`approvals.ts:787-796`）は**対象ユーザー**が承認するが、これは
  コマンド承認ではなくエージェント間委任の同意。

→ **qm 自身の承認では「人間≠エージェント」の分離は作れない**（そもそも起案者が承認するモデル）。
この分離が要るなら、それは Stripe Approvals が供給する（qm には無い four-eyes を Stripe が足す、という関係）。

### 1-4. 「起案＝エージェント / 承認＝人間」を qm 上で成立させられるか

**成立させられる。qm の承認ではなく Stripe Approvals で。** 構成（複数列挙）:

- **構成A（推奨）**: Stripe agent-tagged key を **org スコープ broker credential** として保持
  （`keychain.ts:546-566`）。qm posture は `auto`。エージェントは `execute` の `curl` で
  `POST /v1/refunds` 等を叩く → Stripe が `approval_required` を返す → エージェントが理由文を submit →
  **別の人間**が Stripe Dashboard で承認/却下。Stripe から見た起案者は agent key、承認者は Dashboard の
  人間で、qm 内部の `actorId`（人間）とは独立。
- **構成B（個人帰属が要る場合）**: agent key を per-scope の `VAULT_TOKEN_*` env として個人スコープに置く
  （`src/credentials/connector-token.ts:7`, `skills-seed/linear/SKILL.md` パターン）。ただし
  「その人が起案者」になるので、Stripe の承認者はその人以外の Dashboard ユーザーにする。
- **構成C（二層）**: qm の command policy に require_approval ルールを足してローカルの速度バンプにしつつ
  （§3）、権威ある分離ゲートは Stripe Approvals に置く。

**未確認（キーとネットワークがある環境で消化）**: Stripe が agent key 経由の submit を「その key の身元」
として扱うのか「key を作成した人間」として扱うのか。前者なら key 作成者本人でも承認可能、後者なら作成者は
承認不可。いずれにせよ **Dashboard 承認者を別人にすれば分離は成立**する。これは前マイルストーンの
B 項目（Stripe ライブ挙動）と同種の持ち越し。

---

## 2. 実装を載せる場所

### 2-1. 設計上どこに置くのが正しいか

**`deploy/layers/<org>/sandbox/skills/stripe/SKILL.md` として置く（org レイヤーのスキル）。**
core を byte-identical に保つ制約（README:158-161, `deploy/layers/README.md:54-59`）を満たす唯一の置き方。
レイヤーは git マージではなく**ランタイム配信**で反映される: CLI が `sandbox/tools`・`sandbox/skills` を
束ねて `PUT /v1/deployment-layer` し（`cli/src/deployment-layer.ts:76-92`, `docs/deploy-directory.md:97-99`）、
Core が Postgres `deployment_layer` に SHA-256 で版管理して serve 時に hydrate、`src/deployment/load-layer.ts:76`
が解決、read-only 資産は `src/sandbox/ro-layers.ts:26` でサンドボックスに mount。
core の `src/harness/pi-tools.ts`（tool 定義）・`skills-seed/`（upstream 同梱）・`plugins/`（upstream）を
編集する案はいずれも byte-identical 制約に反するため不可。

### 2-2. `execute` 経由か、独立 tool/skill か

**`execute` 経由になる（かつそれが推奨）。** qm のツール表面は固定で、MCP 的に新ツールを足す口は無い
（`pi-tools.ts:2397-2408` の固定配列）。外部 API はスキルが指示する `curl` を `execute` が実行して到達する。
Stripe 呼び出しも同じ: SKILL.md 本文に `curl https://api.stripe.com/...` を書き、モデルが `execute` で走らせる。
レイヤーの tool descriptor には `egress` ホスト・`auth.credentialPaths`・credential broker・`approvals`（書き込み承認）を
宣言できる（`docs/deploy-directory.md:77-95`, `load-layer.ts:78-113`）。**制約**: broker tool は
1 デプロイに 1 つのみ（`load-layer.ts:80-83`）。

### 2-3. 既存デモ資産の仕分け（qm に載せる場合）

| 既存デモの部品 | qm 上での扱い | 理由 |
|---|---|---|
| `src/agent/planner.ts`（決定論的分類） | **捨てる/縮小** | qm ではモデルが問い合わせを読んで判断する。分類ヒューリスティクスは SKILL.md の指示文に転記すれば足りる |
| `src/agent/justification.ts`（8項目の理由文） | **流用（仕様として）** | Stripe の `reason` に載せる 8 項目フォーマットはそのまま。コードでなく SKILL.md の出力指示になる |
| `src/agent/execute.ts`（action→Stripe v1） | **流用（知識として）** | 返金/請求書二段/解約の API 手順は SKILL.md の curl レシピへ。ディスパッチのコードは execute+モデルが代替 |
| `src/agent/propose.ts`（approval_required 解析→submit） | **流用（手順として）** | 解析＋v2 submit の手順は curl でサンドボックス内実行に移す。Node オーケストレータは不要 |
| `src/stripe-client.ts`（生 fetch, 解析, submit） | **捨てる（レシピは移設）** | HTTP は curl に。credential は keychain/broker が供給 |
| `src/config.ts`（キー強制/2キー分離） | **捨てる** | 資格情報管理は keychain/broker が担う |
| `src/webhook.ts` + `src/audit-store.ts`（JSONL 監査） | **要再設計**（§4） | qm は「durable by default＝Postgres」（AGENTS.md:94-102）。JSONL は不適。propose 側は qm の transcript が拾うが、webhook の非同期状態遷移は別途 durable sink が要る |
| `src/seed.ts` + fixtures | **流用（そのまま）** | 純 Stripe のテストデータ生成。qm 非依存で再利用可 |
| `src/demo.ts`（通しオーケストレーション） | **捨てる** | qm のターン/クロンが代替 |

**qm に載せても捨てずに済む中核資産**: ①Stripe 統合仕様（`approval_required` 形状・v2 submit＋preview
ヘッダ・5 イベント・invoice 二段・返金/解約の叩き方）②理由文 8 項目フォーマット＋M2 ルール表
③seed スクリプト ④`rule_not_enforced`（ゲート未効化を成功偽装しない）という安全チェックの考え方。

---

## 3. 承認の粒度と二重承認

### 3-1. コマンド内容/引数・金額で分岐できるか

**できる（テキスト正規表現として）。** 予告コマンドポリシー（`src/policy/command-policy.ts`）は
`CommandRule { pattern, decision: "allow"|"deny"|"require_approval", reason? }` を、**再構成した
コマンドライン全体**に対して**大文字小文字無視の正規表現**でマッチする（`firstMatch`, `command-policy.ts:769-791`）。
`scannableCommand`（`:66-85`）は heredoc 除去・クオート除去・`$'...'` 復号・`$()`/`eval`/`bash -c`/
pipe-to-shell などの実行サブペイロードを深さ 8 まで再帰展開（`:758-767`）。よって部分文字列・特定フラグ
（`--force`, `-r`）・サブコマンド・**金額の数字リテラル**もマッチ可能。ただし**構造化/型付き述語や数値比較
演算子は無い**（「> 100」は正規表現の文字パターンで書くしかない）。org フロアの例に `rm -r`・`git push --force`・
`drop/truncate table`・pipe-to-shell が require_approval で入っている（`command-policy.ts:5-19`）。
適用はシェル実行経路のみ（`src/tools/primitives.ts:479-489,793-801`）で、**posture と独立に常時**動く。
非シェルツールには適用されない。

### 3-2. 「通常は Auto、金が動く操作だけ止める」は表現できるか

**シェルコマンドについては第一級で可能。** posture を `auto`（全ツール一括停止はしない）に置き、
`require_approval` の CommandRule を金が動く curl（例: `api.stripe.com/v1/refunds` や金額パターン）に当てる。
そのコマンドだけ `NeedsApproval` で止まり、他は無人で流れる。Stripe 呼び出しは `execute` のシェルなので
この経路に乗る。レイヤーからルール追加も可能（layerRules、承認は tighten のみ, `load-layer.ts:100-106`,
`docs/deploy-directory.md:90`）。
**邪魔するもの**: ①シェル限定（非シェルツールを引数条件で止める術は無い。ツール単位で止めるには
Strict だが Strict は全ツール一括, `pi-tools.ts:2429-2435`）。②このゲートの承認も**自己承認**（起案者が承認）
なので「人間≠エージェント」にはならない。③正規表現はヒューリスティック（難読化に弱い、数値比較不可）。

### 3-3. 二重承認になった場合どちらを主にするか（判断材料のみ）

- qm の command-policy 承認 = ローカルの速度バンプ。**自己承認**（起案者本人）で、SECURITY.md:88-91 も
  「command policy はバイパス可能な speed bump」と明言。分離の保証にはならない。
- Stripe Approvals = 実際に金が動く場所での**四眼分離**。Dashboard の Security history に監査が残る。
- 材料: 「分離の強さ」「効果が発生する場所」「監査の残り先」を見ると、権威ゲートは Stripe 側に置くのが自然。
  qm 側は残すなら軽いローカル警告に留める。（結論は指示どおり出さない。）

---

## 4. 監査ログの接続

### 4-1. qm はエージェント操作の何を記録するか

**2系統ある（混同しないこと）。**

- **audit_log**（`src/audit/audit-log.ts`, Postgres 実体 `src/admin/postgres-audit-log.ts:22-35`）:
  スキーマは `{ at, principal_id, action, resource, scope_label, status?, detail?, idempotency_key? }`。
  粗い基盤アクション（デプロイ・egress・コマンド承認決定 `orchestrator.ts:1301,1317` 等）で、
  **LLM ツールコール 1 件ごとの行は書かれない**。**JSON 列は無い**（構造化メタデータ不可、`detail` テキストのみ）。
- **run_activity**（`src/runs/postgres-run-activity-store.ts:5-13`, `payload JSONB`）: エージェントの
  ツールコールはここ。型は `tool_call | tool_result | approval_request | approval_resolved`
  （`orchestrator.ts:169`）。ただし **TTL 1 時間で削除**（`RUN_ACTIVITY_TTL_MS`, `:30`）＝**揮発性**。
- **session_entries**（`src/sessions/postgres-session-store.ts:172-175`）: 全 transcript（tool_call/tool_result 含む）が
  **durable** に残る。
- 承認は「1 レコードを approved→executed と更新」ではなく **append-only のイベント対**
  （request と resolve が別エントリ）。in-place で status 遷移する数少ない例は keychain ask
  （`status` pending→approved/declined/expired, `keychain.ts:104-122`）だが credential スコープ限定。

### 4-2. Stripe の approval_request ID・dashboard_url・状態遷移を紐づけられるか／二重管理を避けられるか

- **audit_log には構造化では入らない**（`detail` 文字列に押し込むしかない）。JSON の置き場は
  run_activity.payload（JSONB）だが**1h で消える**。durable な JSON は session_entries だが transcript。
- **propose 側は二重管理を避けられる**: Stripe 呼び出しが `execute` の curl として走るため、
  `approval_required` の本文（`approval_request` id・`dashboard_url`）とリクエストは **tool_call/tool_result として
  qm の durable transcript に自然に載る**。ここは既存 JSONL を捨ててよい。
- **webhook 側は避けきれない**: 承認後の `approved→succeeded` 等は**ターン外**（Stripe→webhook）で起きるため
  run_activity/session_entries には自然に入らない。qm には「外部承認 id ＋状態タイムライン」を持つ
  汎用 durable ストアが無い。AGENTS.md:94-102 の「durable by default＝Postgres」に従うなら、
  小さな org プラグイン＋自前テーブル、または起案スコープの memory/notebook に durable 記録する追加実装が要る。

→ 「二重管理にせずに済むか」への答え: **propose 側は qm transcript で一元化できるが、非同期 webhook の
状態機械は qm 標準では受け皿が無く、durable sink を足す必要がある**（これが唯一の新規実装ポイント）。

---

## 5. 立ち上げコスト

- **最小起動**: `npm start`（`package.json:12`, `node --env-file-if-exists=.env src/index.ts`）。env なしなら
  全ストア in-memory、harness は mock、Slack なし、DB なし。
- **Postgres**: **必須ではない**。既定は in-memory（揮発）。`config.databaseUrl` があるときだけ Postgres
  （`src/wiring.ts:461` 等）。**sqlite は削除済み**（`src/config.ts:560-565` が sqlite 指定を例外に）。
  durable が欲しいときのみ `DATABASE_URL`。
- **Slack 不要・web UI のみ可**。core は Slack なしで listen（`src/index.ts:100,113-132`、`.env.example` の
  Slack トークンはコメントアウト）。web UI は独立サービス（`deploy/web-ui/Dockerfile` が `plugins/web-ui` を
  ビルド、core へ署名付き HTTP で proxy、`GET /v1/approvals/{requestId}` も持つ）。**core + web UI・Slack ゼロ**で動く。
- **Redis 不要**（キュー/リーダー選出は Postgres advisory lock, `src/persistence/leader-lease.ts`）。
- **ブート時の外部依存**: dev では実質ゼロ。署名秘密群は production のみ必須
  （`src/deployment/secret-schema.ts:24-28`）。モデルキーは `MODEL_PROVIDER` 設定時のみ必須（`:29-31`）。
  実ターンには結局モデルキーが要る。

### 現在の実行環境での再現度

- できる: `npm install`（registry は許可）、core を in-memory + mock harness で起動（構造確認）。
  anthropic.com は proxy 許可リストにあるのでモデルキーがあれば実ターンも到達可能。
- できない（キー/ネットワーク持ち越し）: Stripe への到達（proxy が api.stripe.com を 403）と Stripe キー、
  ANTHROPIC_API_KEY 等のモデルキー未設定。よって **Stripe を絡めた end-to-end はこの環境では再現不可**。
  本タスクは調査なので qm の起動自体は行っていない。

---

## 6. 結論と持ち越し

### 6-3. qm に載せ替えるべきか

**この「ポートフォリオ用デモ」としては、スクラッチ CLI を主成果物のまま進めることを推奨。**
理由:

- デモの主張は「AI が起案し、Stripe Approvals が人手承認までブロックする」。スクラッチ版はその主張を
  最小ノイズで示せる。qm を挟むと Postgres/モデルキー/サンドボックス/レイヤー配信など可動部が増え、主張が薄まる。
- qm の**自前承認は自己承認**で four-eyes を持たない（§1-3）。本デモの核（人間≠エージェントの承認分離）は
  結局 Stripe が供給するので、qm の承認機能はこのデモの主張にほとんど寄与しない。
- 非同期 webhook の状態機械を置く durable な受け皿が qm 標準に無く、追加実装が要る（§4-2）。

**ただし qm は「本番化ターゲット」として有力**で、載せ替え自体は**小さい**（org レイヤーのスキル 1 枚＋
org broker credential）。従って推奨は「スクラッチ版をデモの主成果物にしつつ、qm 用の薄い org レイヤースキルを
"実マルチプレイヤー基盤に載る第二成果物" として別途示す」。デモを丸ごと qm の上に作り直して主成果物にはしない。

### どちらの道でも捨てずに済む資産

Stripe 統合仕様（approval_required 形状・v2 submit＋preview ヘッダ・5 イベント・invoice 二段・返金/解約）、
理由文 8 項目フォーマット＋M2 ルール表、seed スクリプト、`rule_not_enforced` 安全チェックの考え方。
これらは CLI でも qm スキルでもそのまま生きる。

### 6-4. キーとネットワークがある環境に持ち越す項目

1. Stripe が agent key 経由 submit を「key の身元」と扱うか「key 作成者の身元」と扱うか（§1-4 の分離可否に直結）。
2. `POST /v2/core/approval_requests/{id}/submit`（preview 版）と `approval_required` 本文の実挙動（前マイルストーン B）。
3. qm を実際にモデルキー＋Stripe broker credential＋api.stripe.com への egress ありで end-to-end 起動して確認。
4. qm の egress は v1 では validated-only（強制ではない, `docs/deploy-directory.md:142`）。Stripe スキルを
   api.stripe.com に固定できるか。
5. 「broker tool は 1 デプロイ 1 つ」制約（`load-layer.ts:80-83`）が他の org broker credential と衝突しないか。
6. `VAULT_TOKEN_*` の実サンドボックス env 注入の end-to-end（名前生成は確認済みだが注入コードは未追跡・未確認）。

### 未確認（読んで確定できなかった点）

- published app の「per-app acting-as access」（SECURITY.md:65-67）が独立 principal を発行するかは、
  focus 外で非人間 `Principal` コンストラクタを `src/identity`/`src/auth` に見つけられず未確認。
- 非 Slack サーフェス（`src/api/user-scoped-routes.ts` 等）が独自の起案者==承認者チェックを持つかは網羅していない。
  §1-3 の結論は全サーフェス共通の `POST /v1/turns`→`app.turn` 経路に依拠。
- run_activity/session_entries の payload の既存コンシューマが Stripe のカスタムキーを保持/表示するかは未確認。
