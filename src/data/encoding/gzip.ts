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
  const stream = readable.pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
