import { describe, it, expect } from "vitest";
import {
  bytesToBase64url,
  base64urlToBytes,
} from "../src/data/encoding/base64url";
import { gzipBytes, gunzipBytes } from "../src/data/encoding/gzip";
import { pack } from "../src/data/load";
import {
  MAX_HASH_PAYLOAD_LEN,
  defaultPlan,
  encodePlan,
  loadPlan,
} from "../src/data/plan";

describe("base64url", () => {
  it("round-trips a known byte sequence", () => {
    const input = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);
    expect(base64urlToBytes(bytesToBase64url(input))).toEqual(input);
  });

  it("handles empty input", () => {
    expect(bytesToBase64url(new Uint8Array(0))).toBe("");
    expect(base64urlToBytes("")).toEqual(new Uint8Array(0));
  });

  it("matches a pinned base64url output for 'Hello'", () => {
    expect(bytesToBase64url(new Uint8Array([72, 101, 108, 108, 111]))).toBe(
      "SGVsbG8",
    );
  });

  it("round-trips a large buffer without RangeError and uses url-safe alphabet", () => {
    const input = new Uint8Array(100_000).map((_, i) => i & 0xff);
    const encoded = bytesToBase64url(input);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64urlToBytes(encoded)).toEqual(input);
  });
});

describe("gzip", () => {
  it("round-trips a known string", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const input = new Uint8Array(bytes);
    expect(await gunzipBytes(await gzipBytes(input))).toEqual(input);
  });

  it("round-trips an empty buffer", async () => {
    const input = new Uint8Array(0);
    expect(await gunzipBytes(await gzipBytes(input))).toEqual(input);
  });

  it("compresses a 4 KB repetitive buffer by at least 10x and emits gzip framing", async () => {
    const input = new Uint8Array(4096).map((_, i) => "abcd".charCodeAt(i % 4));
    const compressed = await gzipBytes(input);
    expect(compressed.length * 10).toBeLessThan(input.length);
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
  });
});

describe("envelope round-trip", () => {
  it("encodePlan returns a 'v1.<base64url>' string", async () => {
    const hash = await encodePlan(defaultPlan(pack));
    expect(hash.startsWith("v1.")).toBe(true);
    expect(hash.slice("v1.".length)).not.toMatch(/[+/=]/);
  });

  it("loadPlan after encodePlan returns the same plan (loaded)", async () => {
    const plan = defaultPlan(pack);
    const hash = await encodePlan(plan);
    const outcome = await loadPlan("#" + hash, pack);
    expect(outcome.kind).toBe("loaded");
    if (outcome.kind === "loaded") {
      expect(new Set(outcome.plan.targets.map((t) => t.recipeId))).toEqual(
        new Set(plan.targets.map((t) => t.recipeId)),
      );
      expect(outcome.plan.version).toBe(1);
      expect(outcome.plan.pack.id).toBe(pack.source.name);
    }
  });

  it("idempotence: two encodes of the same plan produce byte-identical strings", async () => {
    const plan = defaultPlan(pack);
    expect(await encodePlan(plan)).toBe(await encodePlan(plan));
  });

  it("encoded defaultPlan payload fits under 4 KB", async () => {
    const hash = await encodePlan(defaultPlan(pack));
    expect(hash.length).toBeLessThan(4096);
  });
});

describe("loadPlan envelope handling", () => {
  it("empty hash yields a seeded outcome with the default plan", async () => {
    const outcome = await loadPlan("", pack);
    expect(outcome.kind).toBe("seeded");
    if (outcome.kind === "seeded") {
      expect(outcome.plan.version).toBe(1);
    }
  });

  it("'#' alone yields a seeded outcome", async () => {
    const outcome = await loadPlan("#", pack);
    expect(outcome.kind).toBe("seeded");
  });

  it("garbage hash yields a malformed-hash error", async () => {
    const outcome = await loadPlan("#garbage", pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("malformed-hash");
    }
  });

  it("unrecognized envelope version surfaces the version number", async () => {
    const outcome = await loadPlan("#v99.AAA", pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error" && outcome.error.kind === "unrecognized-version") {
      expect(outcome.error.got).toBe(99);
    } else {
      throw new Error(`expected unrecognized-version, got ${JSON.stringify(outcome)}`);
    }
  });

  it("payload exceeding MAX_HASH_PAYLOAD_LEN surfaces a payload-too-large error", async () => {
    const oversized = "#v1." + "A".repeat(MAX_HASH_PAYLOAD_LEN + 1);
    const outcome = await loadPlan(oversized, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error" && outcome.error.kind === "payload-too-large") {
      expect(outcome.error.limit).toBe(MAX_HASH_PAYLOAD_LEN);
    } else {
      throw new Error(`expected payload-too-large, got ${JSON.stringify(outcome)}`);
    }
  });

  it("wire-decode failure surfaces a malformed-hash error", async () => {
    const outcome = await loadPlan("#v1.A", pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("malformed-hash");
    }
  });
});
