/** Bound both streaming allocation and wall-clock read time, including chunked bodies. */
export async function readBoundedJson(body: ReadableStream<Uint8Array> | null, maxBytes = 1_000_000, timeoutMs = 10000): Promise<unknown> {
  if (!body) throw new Error('Body tidak tersedia.');
  const reader = body.getReader();
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error('Pembacaan body melewati deadline.')), timeoutMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Body melebihi batas.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
