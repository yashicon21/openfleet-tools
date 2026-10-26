import { describe, expect, it } from "vitest";
import { redact, redactString } from "../src/redact.js";

describe("redactString", () => {
  it.each([
    ["github classic token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end"],
    [
      "github fine-grained token",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP",
    ],
    ["aws access key", "AKIAIOSFODNN7EXAMPLE"],
    ["openai style key", "sk-proj-abcdefghijklmnopqrstuvwxyz123456"],
    ["bearer header", "Authorization: Bearer abc.def.ghi-123456789"],
    ["url credentials", "https://user:s3cretpass@example.com/repo.git"],
    ["key=value secret", 'password="hunter2hunter2"'],
  ])("redacts %s", (_label, input) => {
    const out = redactString(input);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/ghp_abcdef|AKIAIOSFODNN7|hunter2hunter2|s3cretpass|sk-proj-abc/);
  });

  it("redacts private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactString(`before\n${key}\nafter`)).toBe("before\n[REDACTED]\nafter");
  });

  it("leaves ordinary text alone", () => {
    const text = "const total = items.reduce((a, b) => a + b, 0); // see https://example.com/docs";
    expect(redactString(text)).toBe(text);
  });
});

describe("redact", () => {
  it("walks nested objects and arrays without mutating input", () => {
    const input = { a: ["ok", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"], b: { c: 1, d: "x" } };
    const out = redact(input);
    expect(out.a[1]).toBe("[REDACTED]");
    expect(out.b).toEqual({ c: 1, d: "x" });
    expect(input.a[1]).toMatch(/^ghp_/);
  });
});
