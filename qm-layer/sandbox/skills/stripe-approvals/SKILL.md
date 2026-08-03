---
name: stripe-approvals
description: Propose an accounting action (refund, invoice, or subscription cancellation) that must clear a HUMAN approval before it executes. Use when a customer inquiry asks to move money — a refund, issuing an invoice, or cancelling a subscription. The action is submitted to Stripe Approvals with a written justification; Stripe blocks execution until a person approves it in the Stripe Dashboard. You never approve it yourself.
requiredCapabilities:
  - egress:api.stripe.com
---

# Stripe Approvals — propose money-moving actions for human approval

Use this skill when a customer inquiry asks to **refund a charge**, **issue an invoice**,
or **cancel a subscription**. You (the agent) decide the action, write a justification,
and submit it to Stripe. **Stripe Approvals holds execution until a human approves it in
the Stripe Dashboard.** You never approve your own proposal — that separation is the whole
point, and Stripe enforces it on its side.

Test mode only. Every key here is a Stripe TEST key. Never operate in live mode.

## What you can propose

| Inquiry intent | Stripe action | Endpoint |
| --- | --- | --- |
| Refund a paid charge | refund | `POST /v1/refunds` |
| Issue an invoice for agreed work | invoice | `POST /v1/invoiceitems` then `POST /v1/invoices` |
| Cancel a subscription | cancel | `DELETE /v1/subscriptions/{id}` |

A money-that-does-not-move edit (e.g. updating customer metadata) is **not** a proposal —
do it directly if asked, and expect no approval step (contrast case).

## How the credential reaches Stripe

You never hold the Stripe key. It is a **shared org service credential** vended by the
core credential broker. Your system prompt lists it under "Shared org credentials
available to you" with its slug (referred to below as `<stripe-slug>`), host
`api.stripe.com`, and allowed methods/paths. If that entry is absent, or
`$AGENT_CREDENTIAL_TOKEN` is unset, you have no Stripe access — say so and stop; do not ask
anyone to paste a key.

Every Stripe call goes **by proxy** through the broker. The core stamps the secret onto the
outbound request; the reply is an envelope `{ "status", "contentType", "body" }` where
`body` is the upstream Stripe response text.

```bash
curl -fsS -X POST "$AGENT_API_URL/v1/credentials/broker" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "credential": "<stripe-slug>",
        "method": "POST",
        "url": "https://api.stripe.com/v1/refunds",
        "headers": { "content-type": "application/x-www-form-urlencoded" },
        "body": "payment_intent=<pi_id>&amount=<amount>"
      }'
```

Then read the envelope's `body` (parse it as JSON). Stripe v1 wants form-encoded bodies;
put them in the `body` field as shown.

## The flow — every proposal follows these six steps

1. **Read the inquiry.** Identify the customer and what they are asking for.
2. **Decide** the action, the target object id (charge/payment_intent, customer, or
   subscription), and the amount. Resolve ids from the conversation/context — do not invent
   them.
3. **Call Stripe** by proxy (broker curl above) with the chosen action.
4. **Expect `approval_required`.** A gated action does NOT execute. Stripe returns an error
   envelope; parse `body` and read `error.approval_request` for `id`, `action`, `status`,
   `dashboard_url`, `expires_at`.
5. **Write the justification and SUBMIT it.** Build the justification (format below) and
   post it as the `reason`:

   ```bash
   curl -fsS -X POST "$AGENT_API_URL/v1/credentials/broker" \
     -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
     -H "content-type: application/json" \
     -d '{
           "credential": "<stripe-slug>",
           "method": "POST",
           "url": "https://api.stripe.com/v2/core/approval_requests/<apreq_id>/submit",
           "headers": {
             "Stripe-Version": "2026-06-24.preview",
             "content-type": "application/json"
           },
           "body": "{\"reason\":\"<the justification text>\"}"
         }'
   ```

   You MUST submit. An auto-created approval request that is never submitted is not shown to
   reviewers and lapses in 24 hours.
6. **Report and stop.** Post the `approval_request` id and `dashboard_url` back to the
   channel so a human can approve/deny in the Dashboard. Do **not** wait synchronously, do
   **not** re-run the action, and do **not** retry a pending request. After a human
   approves, Stripe executes the action itself; the result comes back out of band.

## The justification format (must match the approval rule's instructions)

Emit exactly these eight lines as the `reason`. They mirror the custom justification
instructions configured on each Stripe approval rule — keep them in lockstep.

```
【AIバックオフィス 起案理由】
起案根拠(問い合わせ): <inquiry reference>
対象顧客: <customer id>
アクション: <日本語ラベル> (<action>)
対象オブジェクト: <object id>
金額: <¥amount or —>
判断根拠コード: <reason code>
判断根拠: <one-sentence rationale grounded in the inquiry>
起案者: stripe-approvals skill (agent-tagged key / test mode)
```

`判断根拠コード` examples: `duplicate_charge`, `weak_justification`, `agreed_service_fee`,
`customer_requested_cancellation`. If the grounds are thin or the request looks unusual,
say so plainly in `判断根拠` — a rejected proposal is a correct outcome, not a failure.

## Endpoint recipes

**Refund** (full or partial). Prefer `payment_intent`; `amount` optional for full refund:

```
method: POST  url: https://api.stripe.com/v1/refunds
body:   payment_intent=<pi_id>&amount=<amount>
```

**Invoice** — two calls; the gated action is the invoice creation, not the item:

```
method: POST  url: https://api.stripe.com/v1/invoiceitems
body:   customer=<cus_id>&amount=<amount>&currency=jpy&description=<text>

method: POST  url: https://api.stripe.com/v1/invoices
body:   customer=<cus_id>&collection_method=send_invoice&days_until_due=7&pending_invoice_items_behavior=include
```

**Cancel subscription** (irreversible — always gated):

```
method: DELETE  url: https://api.stripe.com/v1/subscriptions/<sub_id>
```

## If `approval_required` does NOT come back

If a refund / invoice / cancel **succeeds outright** with no `approval_required`, the
approval rule is **not enforcing**. Treat this as `rule_not_enforced`: do not report it as
success — warn loudly that the money-moving action ran WITHOUT human approval and that the
Stripe rule for that action needs checking. Money moved without a human in the loop is the
exact failure this skill exists to prevent.

## Guardrails

- Never operate in live mode; never try to read the raw Stripe key back from the broker.
- Never approve or work around your own proposal. Approval is a human action in the Stripe
  Dashboard, by someone other than the proposer.
- A write is a write even when allowed: submit the justification and hand off; do not force
  a result.

## 未検証 (UNVERIFIED against live Stripe)

The exact `approval_required` body shape, the `/v2/.../submit` response, and whether Stripe
attributes an agent-key submission to the key's own identity or to the human who created
the key are coded to Stripe's published Approvals docs, **not** confirmed against a live
agent key. If live behaviour differs from the recipes above, surface the raw envelope
`status`/`body` — do not fall back to a success path. See `docs/qm-skill.md` for the full
list.
