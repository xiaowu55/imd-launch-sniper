/** A response must be bounded while streaming, before decoding or parsing it.
 * Content-Length is only an early rejection hint; chunked and compressed bodies
 * are still checked against the actual decoded response bytes. Errors never echo
 * remote contents, which can include RPC credentials or signed transactions. */
export class BoundedJsonError extends Error {
  constructor(readonly code: "too_large" | "invalid_json" | "aborted" | "read_failed") {
    super(`Bounded JSON response failed: ${code}`);
    this.name = "BoundedJsonError";
  }
}

export async function readBoundedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("Invalid response size limit");
  const cancelBody = () => { void response.body?.cancel().catch(() => {}); };
  if (signal?.aborted) { cancelBody(); throw new BoundedJsonError("aborted"); }
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxBytes)) {
    cancelBody();
    throw new BoundedJsonError("too_large");
  }
  if (!response.body) throw new BoundedJsonError("invalid_json");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal?.aborted) throw new BoundedJsonError("aborted");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new BoundedJsonError("aborted");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BoundedJsonError("too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new BoundedJsonError("invalid_json"); }
  } catch (error) {
    cancel();
    if (error instanceof BoundedJsonError) throw error;
    throw new BoundedJsonError(signal?.aborted ? "aborted" : "read_failed");
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
