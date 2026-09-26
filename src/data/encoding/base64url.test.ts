import { describe, expect, test } from "vitest";
import { bytesToBase64 } from "./base64url";

describe("bytesToBase64", () => {
  test("encodes with the standard alphabet and padding", () => {
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff, 0x61]))).toBe("+/9h");
    expect(bytesToBase64(new Uint8Array([0x61]))).toBe("YQ==");
  });

  test("encodes no bytes as an empty string", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  test("encodes an array longer than one fromCharCode chunk", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 256);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    expect(bytesToBase64(bytes)).toBe(btoa(binary));
  });
});
