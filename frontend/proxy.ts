import type { NextRequest } from 'next/server';
import { authorizeApi } from './app/lib/auth.ts';

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/api/tele-bot' && request.method === 'POST') return;
  return authorizeApi(request) || undefined;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
