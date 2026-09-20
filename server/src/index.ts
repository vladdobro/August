import { startServer } from './app.js';

startServer().catch((err) => {
  console.error('Failed to start August server:', err);
  process.exit(1);
});
