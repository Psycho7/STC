// Cap on the bytes a single gunzip may produce. The fragment cap upstream is
// on the compressed payload, and gzip expands repetitive text about 1000:1, so
// a 16 KB hash can carry a multi-megabyte body. Reading chunk by chunk stops at
// the cap instead of buffering the whole expansion first.
export const MAX_DECOMPRESSED_BYTES = 256 * 1024;

export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const stream = readable.pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const stream: ReadableStream<Uint8Array> = readable.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DECOMPRESSED_BYTES) {
        await reader.cancel();
        throw new Error(
          `decompressed payload exceeds ${MAX_DECOMPRESSED_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
