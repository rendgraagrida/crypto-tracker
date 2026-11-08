import { authorizeApi, hasWebhookSecret, validUpdate } from '../../lib/auth.ts';
import { createBotStore } from '../../lib/bot-store.ts';
import { acceptUpdate } from '../../lib/bot-runtime.ts';
import { readBoundedJson } from '../../lib/bounded-json.ts';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';
const MAX_BODY = 65536;

export async function GET(request: Request) {
  const denied = authorizeApi(request);
  if (denied) return denied;
  return Response.json({ configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALLOWED_USER_IDS && process.env.TELEGRAM_CHAT_ID), transport: process.env.BOT_TRANSPORT || 'polling', webhookAutoRegistration: false });
}

export async function POST(request: Request) {
  const fromTelegram = hasWebhookSecret(request);
  if (!fromTelegram) {
    const denied = authorizeApi(request);
    if (denied) return denied;
  } else if (process.env.BOT_TRANSPORT !== 'webhook') return Response.json({ error: 'Transport webhook tidak aktif.' }, { status: 409 });
  let body: unknown;
  try { body = await readBoundedJson(request.body, MAX_BODY, 5000); }
  catch { return Response.json({ error: 'Payload tidak valid, terlalu besar, atau melewati deadline.' }, { status: 400 }); }
  if (!fromTelegram) {
    if (!body || typeof body !== 'object' || !('action' in body)) return Response.json({ error: 'Aksi tidak valid.' }, { status: 400 });
    try {
      const store = createBotStore();
      if (body.action === 'test') {
        const destination = process.env.TELEGRAM_CHAT_ID;
        if (!destination) return Response.json({ error: 'Tujuan Telegram belum dikonfigurasi.' }, { status: 503 });
        await store.enqueue(`test:${randomUUID()}`, 'send', { chatId: destination, html: 'Pesan uji bot diterima. Ini bukan bukti scanner atau analisis AI telah berhasil.' });
      } else if (body.action === 'scan_and_alert') await store.enqueue(`manual-scan:${randomUUID()}`, 'scan', {});
      else return Response.json({ error: 'Aksi tidak didukung.' }, { status: 400 });
      return Response.json({ success: true, queued: true }, { status: 202 });
    } catch { return Response.json({ error: 'Antrean belum siap.' }, { status: 503 }); }
  }
  if (!validUpdate(body)) return Response.json({ error: 'Update tidak valid.' }, { status: 400 });
  try {
    await acceptUpdate(createBotStore(), body);
    return Response.json({ ok: true }); // Acknowledge only after the durable insert succeeds.
  } catch { return Response.json({ error: 'Antrean belum siap; Telegram dapat mencoba ulang.' }, { status: 503 }); }
}
