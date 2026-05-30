if (
  typeof globalThis.CompressionStream === "undefined" ||
  typeof globalThis.DecompressionStream === "undefined"
) {
  throw new Error(
    "encoding tests require CompressionStream / DecompressionStream globals; this runtime is missing them",
  );
}
