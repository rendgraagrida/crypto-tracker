// Deterministic network interception preload for bot child process.
// Redirects external provider requests to the parent test fixture server.

const originalFetch = globalThis.fetch;
const proxyUrl = process.env.FIXTURE_PROXY_URL;

if (proxyUrl) {
  globalThis.fetch = async (input, init) => {
    let rawUrl = '';
    if (typeof input === 'string') {
      rawUrl = input;
    } else if (input instanceof URL) {
      rawUrl = input.toString();
    } else if (input && typeof input === 'object' && 'url' in input) {
      rawUrl = input.url;
    }

    // Allow direct loopback requests to local servers (e.g. fake PostgREST or local health checks)
    if (
      rawUrl.startsWith(proxyUrl) ||
      rawUrl.startsWith('http://127.0.0.1:') ||
      rawUrl.startsWith('http://localhost:')
    ) {
      return originalFetch(input, init);
    }

    // Route external calls (Telegram, DexScreener, RugCheck, Hermes) through the parent fixture proxy
    const targetUrl = new URL(`${proxyUrl}/proxy`);
    targetUrl.searchParams.set('url', rawUrl);

    const headers = new Headers(
      init?.headers || (typeof input === 'object' && input && 'headers' in input ? input.headers : {})
    );
    headers.set('x-intercepted-url', rawUrl);

    return originalFetch(targetUrl.toString(), {
      ...init,
      headers,
    });
  };
}
