import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local mock of a paid-data seller API (M12-2). Each endpoint answers with a
 * fixed behaviour so every delivery outcome can be produced on demand:
 *
 *   ok       200 + JSON data
 *   empty    200 + empty body
 *   500      500 Internal Server Error
 *   503      503 Service Unavailable
 *   timeout  never answers (the buyer's timeout fires)
 *
 * In the x402 version the same endpoints would sit behind the 402 challenge;
 * only the payment side changes, the delivery check stays the same.
 */

export type MockBehaviour = 'ok' | 'empty' | '500' | '503' | 'timeout';

export const ENDPOINTS: Record<string, MockBehaviour> = {
  '/v1/data/fx-rates': 'ok',
  '/v1/data/market-depth': 'empty',
  '/v1/data/news-sentiment': '500',
  '/v1/data/weather-hourly': '503',
  '/v1/data/shipping-eta': 'timeout',
  '/v1/data/credit-score': '503',
  '/v1/data/geo-ip': '500',
};

export interface SellerMock {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startSellerMock(port = 0): Promise<SellerMock> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    const behaviour = ENDPOINTS[path];
    switch (behaviour) {
      case 'ok':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { USDJPY: 151.23, EURJPY: 163.4 }, as_of: new Date().toISOString() }));
        return;
      case 'empty':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('');
        return;
      case '500':
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
        return;
      case '503':
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '120' });
        res.end(JSON.stringify({ error: 'upstream_unavailable' }));
        return;
      case 'timeout':
        return; // hold the socket open and never answer
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const { port: actual } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
