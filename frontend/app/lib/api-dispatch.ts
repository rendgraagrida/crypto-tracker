type RouteModule = Partial<Record<string, (request: Request) => Promise<Response>>>;
const routes: Record<string, () => Promise<unknown>> = {
  '/api/watchlist': () => import('../api/watchlist/route.ts'),
  '/api/track': () => import('../api/track/route.ts'),
  '/api/blacklist': () => import('../api/blacklist/route.ts'),
  '/api/whitelist': () => import('../api/whitelist/route.ts'),
  '/api/settings': () => import('../api/settings/route.ts'),
  '/api/tokens': () => import('../api/tokens/route.ts'),
  '/api/solana': () => import('../api/solana/route.ts'),
  '/api/history': () => import('../api/history/route.ts'),
  '/api/trades': () => import('../api/trades/route.ts'),
  '/api/holders': () => import('../api/holders/route.ts'),
  '/api/indicators': () => import('../api/indicators/route.ts'),
};

/** Only called after HTTP authorization or Telegram owner authorization. Never a user-supplied origin. */
export async function dispatchApi(request: Request): Promise<Response> {
  const route = routes[new URL(request.url).pathname];
  if (!route) return Response.json({ error: 'Endpoint tidak ditemukan.' }, { status: 404 });
  const module = await route() as RouteModule;
  const method = request.method.toUpperCase();
  const handler = module[method];
  if (!handler) return Response.json({ error: 'Metode tidak didukung.' }, { status: 405 });
  return handler(request);
}

export async function internalApi(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith('/api/') || path.includes('://') || path.includes('\\')) throw new Error('Endpoint internal tidak valid.');
  return dispatchApi(new Request(`http://bot.internal${path}`, init));
}
