# M2 — 承認ルール定義（人間の管理者が Dashboard で設定する）

> **前提（現行 Stripe ドキュメント）**
> - **Approvals は preview 機能**。アカウントが `approvals_product_preview` に登録
>   されていないと Settings > Approvals 画面が現れない。**preview 申請が最初の関門**。
> - **デフォルトルールが既にある**：Stripe は agent-tagged key 向けに、**返金作成・
>   サブスク解約を含む複数アクションのデフォルト承認ルール**を維持している。preview が
>   有効なら、下の表のルールを自作しなくても返金・解約は承認必須になる。下の表は
>   「しきい値など条件を自分で調整したい場合」や「デフォルト対象外のアクション
>   （請求書作成がデフォルトに含まれるかは要確認 = B-7）」を明示的にゲートしたい場合に使う。
> - **単一メンバーのアカウントでも成立**：agent-tagged key は管理者と独立した actor
>   として扱われるため、`actor condition = agent-tagged API keys` のルールのみ保存でき、
>   判定は「キーの身元」で行われる（1人法人でも 起案=agent / 承認=人間 が成立）。
> - 承認は **Settings > Approvals > Requests** 画面で行う。

承認ルールの作成は **Dashboard の管理者操作**（Settings > Approvals）で行う。
API での作成可否は M0 §B の未消化項目（要ライブ確認）。CC の担当は
**設定内容を確定して提示すること**まで。以下3表のとおり設定し、完了を確認して
から M3（起案）を実運用すること。

共通の前提:

- **すべて test mode**。
- **Client condition = Agent**：agent-tagged key 経由の操作だけを承認対象にする。
  人間が Dashboard から直接行う同種操作は承認対象外（＝管理者が承認と実行を
  兼ねられる。「自分の起案は自分で承認できない」制約と両立させるため、承認者は
  起案 agent とは別の個人にする）。
- **コントロール = Require approval**（Block ではない）。
- **レビュアーは個人指定**：ロール指定だとメール通知が飛ばない。承認操作をする
  実在の個人を指定する。
- **1アクションにつき有効化できるルールは1つ**。
- **custom justification instructions の項目立ては、エージェントが生成する理由文
  （`src/agent/justification.ts`）と一致させる**。エージェントの出力は次の8行:

  ```
  【AIバックオフィス 起案理由】
  起案根拠(問い合わせ): <fixture ID>
  対象顧客: <customer ID>
  アクション: <日本語ラベル> (<action>)
  対象オブジェクト: <object ID>
  金額: <¥金額 または —>
  判断根拠コード: <reason code>
  判断根拠: <一文の要約>
  起案者: ai-backoffice-agent (agent-tagged key / test mode)
  ```

---

## ルール1: 返金（create_refund）

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-返金-承認必須（1,000円超）` |
| 対象アクション | `create_refund` |
| 条件 | 返金額 > **¥1,000**（`REFUND_APPROVAL_THRESHOLD_JPY` と一致）。デモの返金は全て 1,000 円超（¥3,300 / ¥80,000 / ¥5,000）なので3ケースとも承認必須になる |
| Client condition | Agent |
| コントロール | Require approval |
| レビュアー | 個人指定（例: 経理担当者本人。起案 agent とは別人格） |
| custom justification instructions | 「次の8項目を必ず記載すること: 起案根拠(問い合わせ) / 対象顧客 / アクション / 対象オブジェクト / 金額 / 判断根拠コード / 判断根拠 / 起案者。金額の妥当性と重複・不正の有無を確認し承認可否を判断する。」（ラベルは `src/agent/justification.ts` の出力と一致） |

> しきい値の意図: 「少額でも正当なら承認を通す（ケース1）」「高額は当然承認必須
> （ケース2）」「根拠が薄いものは却下（ケース3）」を1本のルールで見せる。閾値以下の
> 極小返金は自動実行される想定だが、デモではその経路を使わない（対比は請求書でなく
> メタデータ更新のケース6が担う）。

---

## ルール2: 請求書作成（Invoice is created）

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-請求書発行-承認必須` |
| 対象アクション | Invoice is created（請求書の作成） |
| 条件 | agent 起案の請求書作成すべて（金額条件なし、または任意の下限）。デモは ¥30,000 |
| Client condition | Agent |
| コントロール | Require approval |
| レビュアー | 個人指定 |
| custom justification instructions | 「請求書発行の起案。記載8項目に加え、請求金額が見積り合意額と一致するかを確認して承認する。」 |

> 粒度の注意: gate 対象は**請求書の作成**。エージェントは先に（承認不要の）
> invoice item を作成してから invoice を作成し、その invoice 作成で
> `approval_required` を受ける。

---

## ルール3: サブスク解約（Subscription is cancelled）

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-解約-承認必須` |
| 対象アクション | Subscription is cancelled（サブスクの解約） |
| 条件 | agent 起案の解約すべて |
| Client condition | Agent |
| コントロール | Require approval |
| レビュアー | 個人指定 |
| custom justification instructions | 「不可逆な解約の起案。記載8項目に加え、対象サブスクリプションと顧客意向の一致、返金要否を確認して承認する。」 |

> 不可逆アクションの例として置いている。承認後は Stripe が解約を自動実行するので、
> こちらから再実行しない。

---

## 設定完了チェック（人間側）

- [ ] 3ルールを Settings > Approvals に作成し、**有効化**した
- [ ] 3ルールとも Client condition = Agent、コントロール = Require approval
- [ ] レビュアーを**個人**で指定した（メール通知のため）
- [ ] 承認者は起案 agent と別人格（自分の起案は自分で承認できない）
- [ ] しきい値 ¥1,000 が `.env` の `REFUND_APPROVAL_THRESHOLD_JPY` と一致

> この表のとおり設定し、上のチェックが全て付いてから M3 を実運用すること。
> ルールが無効・未設定のまま起案すると、gated アクションが素通りし、ログに
> `rule_not_enforced` の警告が出る（＝迂回ではなく検知される）。
