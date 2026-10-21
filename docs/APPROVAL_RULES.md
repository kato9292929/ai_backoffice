# 承認ルール定義（人間の管理者が Dashboard で設定する）

> **前提（Stripe 公式ドキュメント、2026-10-20 再読）**
> - 設定場所は **Settings > [Approvals](https://dashboard.stripe.com/settings/approvals/rules)**。
>   ルールの作成・編集は Dashboard から（**ルールの API はドキュメントに無い**）。既定では
>   Administrator ロールのメンバーだけが作成・編集できる。
> - **対象にできる操作は7つ**：銀行口座の追加・更新・削除 / 管理者の招待 / PaymentIntent の作成 /
>   返金の作成 / サブスクの作成・解約 / クレジットノートの作成 / 顧客残高取引の作成。
>   **請求書は対象外**（M8 で請求書シナリオをクレジットノートに差し替えた）。
> - **条件は amount / actor / rate limit の3種**。複数付けて `and` / `or` で組み合わせられる。
> - **制御は Require approval（承認まで保留）か Block（即時拒否）のどちらか1つ**。
> - **同じ操作に有効なルールは1つだけ**。
> - **agent タグ付きキーのデフォルトルール**：2026-10-21 に sandbox で確認（B-7）。入っていたのは
>   **Refund created** と **Subscription canceled** の2件だけ（Actor = Agent key ／ Submit for approval ／
>   レビュアーは Analyst ほかのロール指定）。API keys ページにある payouts・アカウント設定変更のルールは無い。
>   この2件は新規作成ではなく**そのルールを編集**する（有効なルールは1つだけのため）。
> - **画面の表記**：制御の「Submit for approval」= ドキュメントの「Require approval」。Actor の値は「Agent key」。
> - **単一メンバーのアカウントでも成立**：actor 条件を `agent-tagged API keys` にしたルールは
>   1人のアカウントでも保存できる（agent キーは管理者と独立した actor）。
> - 承認は **Settings > Approvals > Requests**。**14日で自動失効**。自分の起案は自分で承認できない。

CC の担当は**設定内容を確定して提示すること**まで。以下のとおり設定し、チェックが
付いてから起案を運用する。

共通の前提:

- **すべて sandbox / test mode**。
- **Actor condition = agent-tagged API keys**：agent キー経由の操作だけを承認対象にする。
  人間が Dashboard から行う同種操作は対象外。
- **Designated reviewers は個人で指定**：ロール指定だとメール通知が飛ばない
  （Approvals ページ「Only individually assigned team members receive email notifications」）。
- **custom justification instructions の項目立ては、エージェントの理由文
  （`src/agent/justification.ts`）と一致させる**。エージェントの出力は次のとおり（全アクション共通）:

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

## ルール1: 返金の作成（Refund is created）— 承認版

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-返金-承認必須（1,000円超）` |
| 対象操作 | Refund is created |
| 条件 | Actor = Agent key（デフォルトのまま）。Amount > **¥1,000** の追加は**任意**（デモの返金はすべて ¥1,000 超なので、付けても付けなくても全件が承認待ちになる） |
| 制御 | Require approval |
| Designated reviewers | 個人指定（承認ボタンを押す本人） |
| custom justification instructions | 「次の8項目を必ず記載すること: 起案根拠(問い合わせ) / 対象顧客 / アクション / 対象オブジェクト / 金額 / 判断根拠コード / 判断根拠 / 起案者。金額の妥当性と重複・不正の有無を確認し承認可否を判断する。」 |

> **デフォルトの「Refund created」を編集する**。必須の変更はレビュアーに本人を個人として追加することだけ
> （ロール指定のままだと承認待ちのメール通知が届かない）。
> デモの返金は INQ が ¥3,300 / ¥80,000 / ¥5,000、M9・M10 が既定 ¥1,500 で、すべて ¥1,000 超。

---

## ルール2: クレジットノートの作成（Credit note is created）— M8 で追加

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-クレジットノート-承認必須` |
| 対象操作 | Credit note is created |
| 条件 | Actor = agent-tagged API keys（金額条件なし） |
| 制御 | Require approval |
| Designated reviewers | 個人指定 |
| custom justification instructions | 「請求済み金額の減額の起案。記載8項目に加え、対象請求書・減額の理由（未実施分など）・減額金額が妥当かを確認して承認する。」 |

> デフォルトルールの対象外と見込まれるので**新規作成が必要**（B-6 で approval_required が返るかを確認）。
> エージェントは seed 済みの open 請求書（¥30,000）に対し、¥15,000 のクレジットノートを
> custom line item 1行で起案する。

---

## ルール3: サブスクの解約（Subscription is canceled）

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-解約-承認必須` |
| 対象操作 | Subscription is created or canceled（解約） |
| 条件 | Actor = agent-tagged API keys |
| 制御 | Require approval |
| Designated reviewers | 個人指定 |
| custom justification instructions | 「不可逆な解約の起案。記載8項目に加え、対象サブスクリプションと顧客意向の一致、返金要否を確認して承認する。」 |

> **デフォルトの「Subscription canceled」をそのまま使い**、レビュアーに本人を個人として追加する。承認後は Stripe が解約を自動実行するので、こちらから再実行しない。

---

## ルール4（任意）: 顧客残高取引の作成（Customer balance transaction is created）

INQ-007 を有効化するとき（`ENABLE_BALANCE_COMPENSATION=true` / `--with-balance`）だけ必要。

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-残高付与-承認必須` |
| 対象操作 | Customer balance transaction is created |
| 条件 | Actor = agent-tagged API keys |
| 制御 | Require approval |
| Designated reviewers | 個人指定 |
| custom justification instructions | 「返金の代わりに残高付与で補償する起案。記載8項目に加え、補償額の根拠（障害期間など）と、返金でなく残高付与にする顧客意向を確認して承認する。」 |

---

## M9: 暴走シナリオのルール構成（Block 版 / 承認版）

### 1つのルールにまとめられるか

想定は「返金を agent が短時間に連発したら Block、それ以外は承認必須」。ドキュメント上:

- 条件（amount / actor / rate limit）は `and` / `or` で組み合わせられる。
- しかし**制御は1ルールに1つ**（Require approval か Block）。
- **同じ操作に有効なルールは1つだけ**。

したがって「rate limit 超過 → Block、そうでなければ → Require approval」という
**制御の出し分けは1ルールでは表現できない**。条件を組み合わせて作れるのは次のどちらか一方だけ:

- `actor = agent and rate limit 超過` → Block：超過分は拒否されるが、**それ未満は承認なしで即時実行**される
- `actor = agent and rate limit 超過` → Require approval：超過分だけ承認待ちになり、それ未満は即時実行

このため、デモは**ルールを切り替えて2回に分けて流す**設計にした（`--rule-set` はログ上のラベル）。

### Block 版（`npm run demo:runaway -- --rule-set=block`）

| 項目 | 内容 |
|---|---|
| ルール名 | `AI-返金-連発ブロック` |
| 対象操作 | Refund is created |
| 条件 | Actor = agent-tagged API keys **and** Rate limit：**10分間に3件を超えたら** |
| 制御 | **Block** |

流し方: ルール1（承認版）を**無効化**し、このルールを**有効化**してから

```bash
npm run demo:runaway -- --count=5 --interval=10 --amount=1500 --rule-set=block
```

期待: #1〜#3 は即時実行（¥1,500 × 3 がプールから実際に返金される）、#4 以降が Block。
Block のエラー本文は `logs/requests.jsonl` に生のまま残り、`npm run evidence -- --outcome=blocked`
（分類できなかった場合は `--outcome=error`）で取り出して B-9 を確定する。

### 承認版（`npm run demo:runaway -- --rule-set=approval`）

| 項目 | 内容 |
|---|---|
| ルール | ルール1（返金・承認版）。デフォルトルールがあればそれ |
| 条件 | Actor = agent-tagged API keys（and Amount > ¥1,000） |
| 制御 | Require approval |

流し方: Block 版を**無効化**し、ルール1を**有効化**してから

```bash
npm run demo:runaway -- --count=5 --interval=10 --amount=1500 --rule-set=approval
```

期待: 全件 approval_required（承認待ちが5件できる）。デモ後は承認せず、却下するか
`npm run approvals:cancel -- --fixture=RUNAWAY#1` などで取り消す。

---

## 設定完了チェック（人間側）

- [x] Settings > Approvals が表示される（B-0、2026-10-21）
- [x] デフォルトルールの中身を確認し、スクショを取った（B-7、2026-10-21）
- [ ] デフォルトの Refund created / Subscription canceled のレビュアーに本人を**個人として追加**
- [ ] ルール1（返金・承認版 = デフォルトの Refund created）が**有効**
- [ ] ルール2（クレジットノート）を作成し**有効化**
- [ ] M9 用の Block 版ルールを作成し、**保存のみ（無効）**にしてある（M9 実行時に切り替え）
- [ ] 全ルールで Designated reviewers を**個人**で指定した
- [ ] （INQ-007 を使う場合のみ）ルール4を作成し有効化

> ルールが無効・未設定のまま起案すると、gated アクションが素通りし、ログに
> `rule_not_enforced` の警告が出る（＝迂回ではなく検知される）。
