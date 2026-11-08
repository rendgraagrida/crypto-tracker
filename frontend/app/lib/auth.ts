import { timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function normalizeChain(input: string): string {
  const chain = input.trim().toLowerCase();
  const aliases: Record<string, string> = { sol: 'solana', eth: 'ethereum', 'base chain': 'base', binance: 'bsc', bnb: 'bsc', matic: 'polygon', polygon_pos: 'polygon', arbitrum_one: 'arbitrum', op: 'optimism', avax: 'avalanche', rh: 'robinhood', 'robinhood chain': 'robinhood' };
  const result = aliases[chain] || chain;
  if (!['solana', 'ethereum', 'base', 'bsc', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'robinhood'].includes(result)) throw new Error('Jaringan tidak didukung; pilih chain secara eksplisit.');
  return result;
}

export function normalizeAddress(chain: string, input: string): string {
  const address = input.trim();
  if (normalizeChain(chain) === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error('Alamat Solana tidak valid.');
    try { new PublicKey(address); } catch { throw new Error('Alamat Solana tidak valid.'); }
    return address;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Alamat EVM tidak valid.');
  return address.toLowerCase();
}

export function assetKey(chain: string, address: string): string {
  const normalized = normalizeChain(chain);
  return `${normalized}:${normalizeAddress(normalized, address)}`;
}

function equalSecret(actual: string, expected: string): boolean {
  if (!expected || actual.length > 4096) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isOwner(userId: unknown, chatId: unknown): boolean {
  if (typeof userId !== 'number' || typeof chatId !== 'number' || !Number.isSafeInteger(userId) || !Number.isSafeInteger(chatId) || userId <= 0 || chatId === 0) return false;
  const users = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '').split(',').map(v => v.trim()).filter(Boolean);
  return users.includes(String(userId)) && chats.includes(String(chatId));
}

export function hasWebhookSecret(request: Request): boolean {
  return equalSecret(request.headers.get('x-telegram-bot-api-secret-token') || '', process.env.TELEGRAM_WEBHOOK_SECRET || '');
}

/** Shared by the native HTTP server and Next proxy. Fail closed when unconfigured. */
export function authorizeApi(request: Request): Response | null {
  const secret = process.env.BOT_API_TOKEN || '';
  if (secret.length < 32) return Response.json({ error: 'Konfigurasi akses server belum siap.' }, { status: 503 });
  const header = request.headers.get('authorization') || '';
  let candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      if (decoded.startsWith('owner:')) candidate = decoded.slice(6);
    } catch { /* Reject malformed authentication. */ }
  }
  if (equalSecret(candidate, secret)) {
    const origin = request.headers.get('origin');
    const allowed = (process.env.BOT_ALLOWED_ORIGINS || '').split(',').map(v => v.trim());
    // Browsers must come from an explicit operator-approved origin, never a supplied Host header.
    if (origin && !allowed.includes(origin)) return Response.json({ error: 'Origin ditolak.' }, { status: 403 });
    return null;
  }
  return Response.json({ error: 'Autentikasi diperlukan.' }, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Crypto Tracker", charset="UTF-8"', 'Cache-Control': 'no-store' } });
}

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id?: number; text?: string; from?: { id?: number; is_bot?: boolean }; chat?: { id?: number } };
  callback_query?: { id: string; from?: { id?: number; is_bot?: boolean }; data?: string; message?: { message_id?: number; chat?: { id?: number } } };
}

export function updateActor(update: TelegramUpdate): { userId: string; chatId: string } | null {
  const user = update.callback_query?.from || update.message?.from;
  const chat = update.callback_query?.message?.chat || update.message?.chat;
  if (user?.is_bot || !isOwner(user?.id, chat?.id)) return null;
  return { userId: String(user!.id), chatId: String(chat!.id) };
}

export function validUpdate(value: unknown): value is TelegramUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  if (typeof u.update_id !== 'number' || !Number.isSafeInteger(u.update_id) || u.update_id < 0) return false;
  if (u.message !== undefined) {
    if (!u.message || typeof u.message !== 'object' || Array.isArray(u.message)) return false;
    if ('text' in u.message && (typeof u.message.text !== 'string' || u.message.text.length > 8192)) return false;
  }
  if (u.callback_query !== undefined) {
    if (!u.callback_query || typeof u.callback_query !== 'object' || Array.isArray(u.callback_query)) return false;
    const callback = u.callback_query as Record<string, unknown>;
    if (typeof callback.id !== 'string' || typeof callback.data !== 'string' || Buffer.byteLength(callback.data) > 64) return false;
  }
  return true;
}
