/**
 * Read a fetch response without ever buffering more than the caller's limit.
 * A missing or dishonest Content-Length is not trusted: the body is counted
 * chunk by chunk and cancelled as soon as the next chunk crosses the limit.
 */
export async function readResponseBytesLimited(
  response: Response,
  maxBytes: number,
  limitError: string,
) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(limitError);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      try {
        await reader.cancel();
      } finally {
        throw new Error(limitError);
      }
    }
    total += value.byteLength;
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
