import { config, STRIPE_API_BASE } from './config.js';
import { log } from './logger.js';

/**
 * M11 gate — can this account take x402 (machine payments / stablecoin)
 * payments? M11's refund scenario is only built once this says "available".
 *
 * Checks (read-only unless --probe-deposit-address):
 *   1. GET /v1/account                      → account id, country
 *   2. GET /v1/payment_method_configurations → is the `crypto` payment method
 *      ("Stablecoins and Crypto") available on any configuration?
 *   3. --probe-deposit-address: POST /v1/crypto/deposit_addresses network=base
 *      (sandbox, Stripe-Version 2026-07-29.preview per the x402 doc's sandbox
 *      section). Creates a deposit address — harmless, the doc says they can be
 *      created freely — but it is a write, hence opt-in.
 *
 * Docs (2026-10-20): stablecoin payments are available to US businesses (not
 * NY); outside the US, email machine-payments@stripe.com with the account id.
 */

const X402_SANDBOX_VERSION = '2026-07-29.preview';

async function get(path: string, version: string = config.apiVersion) {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${config.secretKey}`, 'Stripe-Version': version },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function main(): Promise<void> {
  log.section('M11 — x402 / machine payments 利用可否');
  const acct = await get('/v1/account');
  const accountId: string = acct.body?.id ?? '(取得失敗)';
  const country: string = acct.body?.country ?? '?';
  console.log(`account: ${accountId}  country: ${country}  (HTTP ${acct.status})`);

  const pmc = await get('/v1/payment_method_configurations?limit=100');
  let cryptoAvailable = false;
  if (pmc.status === 200) {
    for (const c of pmc.body?.data ?? []) {
      const crypto = c.crypto;
      console.log(
        `config ${c.id} (${c.name ?? '-'}${c.is_default ? ', default' : ''}): crypto=` +
          (crypto ? `available=${crypto.available} preference=${crypto.display_preference?.value ?? '-'}` : 'なし'),
      );
      if (crypto?.available) cryptoAvailable = true;
    }
  } else {
    log.warn(`payment_method_configurations HTTP ${pmc.status}`, JSON.stringify(pmc.body?.error ?? pmc.body));
  }

  let probeOk: boolean | null = null;
  if (process.argv.includes('--probe-deposit-address')) {
    const res = await fetch(`${STRIPE_API_BASE}/v1/crypto/deposit_addresses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Stripe-Version': X402_SANDBOX_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'network=base',
    });
    const body = (await res.json().catch(() => ({}))) as any;
    probeOk = res.ok;
    console.log(`deposit address probe: HTTP ${res.status}`, JSON.stringify(res.ok ? { id: body.id } : body.error));
  }

  log.section('判定');
  if (cryptoAvailable || probeOk) {
    log.ok('利用可能 → M11（x402 PaymentIntent の作成と返金起案）に進める');
    return;
  }
  log.warn('利用不可（または未確認）→ M11 の実装は止めたまま');
  if (country !== 'US') {
    console.log('');
    console.log('米国外アカウント: machine-payments@stripe.com にアカウントIDを送って申請する。');
    console.log(`  件名: Request access to stablecoin payments (account ${accountId})`);
    console.log(`  本文に記載: Stripe account ID = ${accountId}, country = ${country}`);
    console.log('  併せて Dashboard > Settings > Payment methods で「Stablecoins and Crypto」をリクエスト');
  } else {
    console.log('Dashboard > Settings > Payment methods で「Stablecoins and Crypto」をリクエストする（NY 州は対象外）。');
  }
}

main().catch((err) => {
  log.error('x402 check failed', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
