import { setTimeout as delay } from 'node:timers/promises';
import { readTradePolicy } from '../app/lib/trade-policy.ts';
import { createTradeStore } from '../app/lib/trade-store.ts';
import { runTradeOnce } from '../app/lib/trade-signer.ts';

// Deliberately separate from bot.ts: no signer keys in the Telegram bot environment.
const reconcileOnly = process.argv.includes('--reconcile-only');
if (process.env.TRADE_LIVE_ENABLED !== 'true' && !reconcileOnly) {
  console.log('Trading OFF. No database, signer key or submission endpoint was accessed.');
} else {
  try {
    const policy = readTradePolicy({ reconcileOnly });
    const store = createTradeStore();
    const shutdown = new AbortController();
    process.once('SIGINT', () => shutdown.abort());
    process.once('SIGTERM', () => shutdown.abort());
    console.log('Isolated executor started; explicit risk gates and durable signed-transaction reconciliation required.');
    do {
      try { await runTradeOnce(store, policy); }
      catch { console.error('Executor storage unavailable. No replacement transaction is authorized.'); }
      if (process.argv.includes('--once')) break;
      await delay(5000, undefined, { signal: shutdown.signal }).catch(() => {});
    } while (!shutdown.signal.aborted);
  } catch {
    console.error('Executor configuration rejected. Check explicit limits, permissions and isolated environment; no key material is logged.');
    process.exitCode = 1;
  }
}
