import { startServer } from './app.js';
import { killLlmServerSync } from './services/llmServer.js';

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
