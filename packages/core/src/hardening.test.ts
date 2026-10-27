import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import AdmZip from "adm-zip";
import { createContext, apiJson } from "./auth.js";
import { extractFit, request } from "./client.js";
import { loadEnv } from "./env.js";
import { GarminError, errorMessage, sanitize } from "./errors.js";
import { MAX_FIT_BYTES, MAX_RESPONSE_BYTES, MAX_RESULT_CHARS, capOutput } from "./limits.js";
import { LapListSchema, RunListSchema, parseResponse } from "./schemas.js";

const realFetch = globalThis.fetch;
const SAVED = { ...process.env };
beforeEach(() => { delete process.env.GARMIN_PERSONAL_API_KEY; });
afterEach(() => { globalThis.fetch = realFetch; process.env = { ...SAVED }; mock.restoreAll(); });

test("error text is stripped of terminal control sequences but keeps newlines", () => {
  assert.equal(sanitize("a\u001b[31mred\u001b[0m\u0007 b\nc\td"), "a[31mred[0m b\nc\td");
  assert.equal(errorMessage(new Error("bad\u001b]0;pwned\u0007")), "bad]0;pwned");
});

test("HTTP errors are built from the status code, never the provider's reason phrase", async () => {
  globalThis.fetch = (async () => new Response("", { status: 400, statusText: "Evil Reason Phrase" })) as typeof fetch;
  await assert.rejects(request("/x", {}), (e: Error) => e instanceof GarminError && /HTTP 400/.test(e.message) && !/Evil/.test(e.message));
});

test("oversized responses are refused, declared or streamed", async () => {
  globalThis.fetch = (async () => new Response("x", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } })) as typeof fetch;
  await assert.rejects(request("/x", {}), /larger than 64 MiB/);

  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    pull(controller) { if (sent++ > 70) controller.close(); else controller.enqueue(chunk); },
  }))) as typeof fetch;
  await assert.rejects(request("/y", {}), /larger than 64 MiB/);
});

test("a decompression bomb is refused before inflating", () => {
  const zip = new AdmZip();
  zip.addFile("a.fit", Buffer.alloc(MAX_FIT_BYTES + 1024)); // compresses to almost nothing
  assert.throws(() => extractFit(zip.toBuffer()), /larger than 100 MiB/);
  const small = new AdmZip();
  small.addFile("a.fit", Buffer.from("ok"));
  assert.equal(extractFit(small.toBuffer()).toString(), "ok");
});

test("CLI output is capped unless --no-limit", () => {
  const big = "x".repeat(MAX_RESULT_CHARS + 1);
  assert.throws(() => capOutput(big), /--no-limit/);
  assert.equal(capOutput(big, true), big);
  assert.equal(capOutput("small"), "small");
});

test("responses that do not match the expected shape fail with a clear error", () => {
  assert.throws(() => parseResponse(RunListSchema, { error: "x" }, "run list"), /Unexpected Garmin response for run list/);
  assert.throws(() => parseResponse(RunListSchema, [{ activityId: 1, distance: "far" }], "run list"), /0\.distance/);
  assert.throws(() => parseResponse(LapListSchema, [{ total_distance: "1000" }], "laps"), /Unexpected Garmin response for laps/);
  const runs = parseResponse(RunListSchema, [{ activityId: 1, startTimeLocal: null, extra: { kept: true } }], "run list");
  assert.deepEqual(runs[0].extra, { kept: true }); // unknown fields are preserved for the raw tools
});

test("a .env readable by others triggers a warning that never contains the key", () => {
  const warn = mock.method(console, "error", () => undefined);
  const dir = mkdtempSync(join(tmpdir(), "gk-perm-"));
  writeFileSync(join(dir, ".env"), "GARMIN_PERSONAL_API_KEY=super-secret\n");
  chmodSync(join(dir, ".env"), 0o644);
  loadEnv(dir);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /chmod 600/);
  assert.ok(!String(warn.mock.calls[0].arguments[0]).includes("super-secret"));

  delete process.env.GARMIN_PERSONAL_API_KEY;
  chmodSync(join(dir, ".env"), 0o600);
  loadEnv(dir);
  assert.equal(warn.mock.callCount(), 1, "no warning for an owner-only file");
});

test("redirects are never followed with credentials", async () => {
  let init: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, i: RequestInit) => { init = i; return new Response("{}"); }) as typeof fetch;
  await apiJson({ token: async () => "t" }, "/x");
  assert.equal(init?.redirect, "error");
  void createContext;
});
