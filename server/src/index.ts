import http from 'node:http';

import { startServer } from './app.js';
import { killLlmServerSync } from './services/llmServer.js';

// Standalone server only (dev, npm start): Node's fetch ignores the system proxy, so Groq is unreachable from blocked
// regions. Honor HTTPS_PROXY / HTTP_PROXY / NO_PROXY when they are set. The packaged app never runs this file — Electron
// swaps fetch for net.fetch, which already follows the system proxy (AUG-138).
const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const withProxy = http as typeof http & { setGlobalProxyFromEnv?: () => void };
if (proxyEnv && typeof withProxy.setGlobalProxyFromEnv === 'function') {
  withProxy.setGlobalProxyFromEnv();
  console.log('Outgoing requests use the proxy from HTTPS_PROXY/HTTP_PROXY (NO_PROXY respected)');
}

startServer().then(() => {
  // AUG-162: never leave llama-server (GBs of RAM) behind when the dev server is stopped.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      killLlmServerSync();
      process.exit(0);
    });
  }
}).catch((err) => {
  console.error('Failed to start August server:', err);
  process.exit(1);
});
