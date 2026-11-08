const MAX_RESPONSE_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;

/** Bound provider response bytes and read time before an SDK parses the body. */
export async function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(input, { ...init, signal });
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abortHandler = () => reject(new Error('Provider response deadline exceeded'));
  if (signal.aborted) abortHandler(); else signal.addEventListener('abort', abortHandler, { once: true });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) { complete = true; break; }
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Provider response too large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers);
    // Fetch can transparently decompress the original body.
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(bytes.buffer, { status: response.status, statusText: response.statusText, headers });
  } finally {
    signal.removeEventListener('abort', abortHandler);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
