import { readBoundedJson } from './bounded-json.ts';
import { setTimeout as delay } from 'node:timers/promises';

const nextSend = new Map<string, number>();

export type InlineKeyboard = { text: string; callback_data: string }[][];
export class TelegramError extends Error {
  retryAfter: number;
  constructor(retryAfter = 0) {
    super('Pengiriman Telegram belum berhasil.');
    this.retryAfter = retryAfter;
  }
}

/** No request URLs, tokens, chat content or provider exceptions are logged. */
export async function telegramRequest(method: 'sendMessage' | 'editMessageText' | 'answerCallbackQuery' | 'getUpdates' | 'getWebhookInfo', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramError();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
    signal: AbortSignal.timeout(method === 'getUpdates' ? 35000 : 12000), body: JSON.stringify(payload),
  }).catch(() => { throw new TelegramError(); });
  const raw = await readBoundedJson(response.body, 1_000_000, 10000).catch(() => null);
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!response.ok || data?.ok !== true) {
    const parameters = data?.parameters;
    const retry = parameters && typeof parameters === 'object' && 'retry_after' in parameters ? Number(parameters.retry_after) : 0;
    throw new TelegramError(Number.isFinite(retry) ? Math.max(0, Math.min(retry, 3600)) : 0);
  }
  return data!;
}

export async function sendBotMessage(chatId: string, html: string, keyboard?: InlineKeyboard): Promise<number> {
  if (html.length > 4000) throw new Error('Pesan melebihi batas aman Telegram.');
  const earliest = Math.max(Date.now(), nextSend.get(chatId) || 0);
  nextSend.delete(chatId);
  nextSend.set(chatId, earliest + 1000);
  while (nextSend.size > 100) nextSend.delete(nextSend.keys().next().value!);
  if (earliest > Date.now()) await delay(earliest - Date.now());
  const data = await telegramRequest('sendMessage', {
    chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
  const result = data.result;
  if (!result || typeof result !== 'object' || !('message_id' in result) || typeof result.message_id !== 'number' || !Number.isSafeInteger(result.message_id)) throw new TelegramError();
  return result.message_id;
}
