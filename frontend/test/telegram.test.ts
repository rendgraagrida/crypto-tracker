import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendBotMessage, TelegramError, telegramRequest } from '../app/lib/telegram.ts';

test('Telegram rejection retains retry_after and never returns a delivered message ID', async () => {
  const fetchOriginal = globalThis.fetch;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
  try {
    globalThis.fetch = async () => Response.json({ ok: false, parameters: { retry_after: 17 }, description: 'rate limited' }, { status: 429 });
    await assert.rejects(sendBotMessage('123', 'test'), error => error instanceof TelegramError && error.retryAfter === 17);
    globalThis.fetch = async () => Response.json({ ok: false, result: { message_id: 1 } });
    await assert.rejects(sendBotMessage('123', 'test'), TelegramError);
  } finally { globalThis.fetch = fetchOriginal; if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = token; }
});

test('missing credentials never make a network request', async () => {
  const fetchOriginal = globalThis.fetch;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not call'); };
  try { await assert.rejects(telegramRequest('getWebhookInfo', {}), TelegramError); assert.equal(called, false); }
  finally { globalThis.fetch = fetchOriginal; if (token !== undefined) process.env.TELEGRAM_BOT_TOKEN = token; }
});
