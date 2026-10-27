import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, closeSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import AdmZip from "adm-zip";
import { createContext, getAccessToken } from "./auth.js";
import { extractFit, request } from "./client.js";
import { GarminError } from "./errors.js";
import { MAX_ZIP_ENTRIES } from "./limits.js";
import { serialize } from "./output.js";
import { HrvSummariesSchema, SleepSummariesSchema, parseResponse } from "./schemas.js";
import { downloadActivity } from "./tools.js";

const realFetch = globalThis.fetch;
const realCwd = process.cwd();
const jwt = (expInSeconds = 86_400) => `h.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + expInSeconds })).toString("base64url")}.s`;
const scratch = () => mkdtempSync(join(tmpdir(), "gk-run2-"));
const mode = (path: string) => lstatSync(path).mode & 0o777;
let urls: string[] = [];

beforeEach(() => { urls = []; });
afterEach(() => { globalThis.fetch = realFetch; process.chdir(realCwd); });

// --- token cache: never write the token into an inode that already exists ---

test("a pre-existing world-readable cache is replaced, never written into", async () => {
  const dir = join(scratch(), "cache");
  mkdirSync(dir, { mode: 0o755 });
  const file = join(dir, "token.json");
  writeFileSync(file, "{not json", { mode: 0o644 });
  chmodSync(file, 0o644);
  const oldReader = openSync(file, "r"); // someone who already had the permissive file open
  globalThis.fetch = (async () => new Response(jwt())) as typeof fetch;

  await getAccessToken("dummy-key", { cacheFile: file });

  assert.equal(readFileSync(oldReader, "utf8"), "{not json", "the old inode must never receive the token");
  closeSync(oldReader);
  assert.equal(mode(file), 0o600);
  assert.match(readFileSync(file, "utf8"), /access_token/);
  assert.deepEqual(readdirSync(dir), ["token.json"], "no temp files left behind");
});

test("a valid cached token in a group/world-readable file is not trusted", async () => {
  const file = join(scratch(), "token.json");
  let posts = 0;
  globalThis.fetch = (async () => { posts++; return new Response(jwt()); }) as typeof fetch;
  await getAccessToken("k", { cacheFile: file });
  assert.equal(posts, 1);
  chmodSync(file, 0o644);
  await getAccessToken("k", { cacheFile: file });
  assert.equal(posts, 2, "readable by others means untrusted: exchange again");
  assert.equal(mode(file), 0o600, "and the replacement is private again");
});

test("a symlink at the cache path is neither read nor followed", async () => {
  const dir = scratch();
  const target = join(dir, "victim.txt");
  writeFileSync(target, "precious");
  const file = join(dir, "token.json");
  symlinkSync(target, file);
  globalThis.fetch = (async () => new Response(jwt())) as typeof fetch;
  const token = await getAccessToken("k", { cacheFile: file });
  assert.match(token, /^h\./, "still works, just without the cache");
  assert.equal(readFileSync(target, "utf8"), "precious", "the symlink target is untouched");
  assert.ok(lstatSync(file).isSymbolicLink(), "and the symlink was left alone");
});

test("an authentication failure on the token exchange is final: the key is sent once", async () => {
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response("", { status: 401 }); }) as typeof fetch;
  const { apiJson } = await import("./auth.js");
  await assert.rejects(apiJson(createContext("k", { cacheFile: null }), "/x"), (e: unknown) => e instanceof GarminError && e.status === 401);
  assert.equal(urls.filter((u) => u.includes("personalapitoken")).length, 1);
});

// --- credentials only go to the Garmin origin ---

test("request refuses any path that could change the host", async () => {
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response("{}"); }) as typeof fetch;
  for (const bad of ["//evil.example/x", "@evil.example/x", "https://evil.example/x", "evil.example", "", "\\\\evil.example"]) {
    await assert.rejects(request(bad, { headers: { Authorization: "Bearer secret" } }), GarminError, JSON.stringify(bad));
  }
  assert.equal(urls.length, 0, "nothing was sent");
  await request("/ok?a=1", {});
  assert.equal(urls[0], "https://personal.connectapi.garmin.com/ok?a=1");
});

test("the body of a failed response is cancelled, not left open", async () => {
  let cancelled = 0;
  globalThis.fetch = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); }, cancel() { cancelled++; } }), { status: 404 })) as typeof fetch;
  await assert.rejects(request("/x", {}), /404/);
  assert.equal(cancelled, 1);
});

// --- ZIP ---

test("archives with too many entries are refused before parsing", () => {
  const zip = new AdmZip();
  for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) zip.addFile(`e${i}.fit`, Buffer.from("x"));
  assert.throws(() => extractFit(zip.toBuffer()), /more than 64 entries/);
  assert.throws(() => extractFit(Buffer.from("not a zip at all, but long enough to scan for a record")), /not a valid ZIP/);
});

// --- output neutralisation ---

test("serialize escapes DEL, C1 and line separators but preserves the data", () => {
  const data = { s: "a\u009b31mb\u007fc\u2028d\u2029e", n: 1 };
  const text = serialize(data);
  assert.ok(!/[\u007f-\u009f\u2028\u2029]/.test(text));
  assert.deepEqual(JSON.parse(text), data);
  assert.equal(serialize("plain\u001b[31m text\n"), "plain[31m text\n", "strings are sanitised");
  assert.equal(serialize({ a: 1 }, true), '{\n  "a": 1\n}');
});

// --- wellness response envelopes ---

test("wellness envelopes are validated and empty bodies are accepted", () => {
  assert.equal(parseResponse(SleepSummariesSchema, null, "sleep summaries"), null);
  assert.deepEqual(parseResponse(HrvSummariesSchema, { hrvSummaries: [{ calendarDate: "2026-10-25", extra: 1 }] }, "HRV").hrvSummaries?.[0].extra, 1);
  assert.throws(() => parseResponse(SleepSummariesSchema, { oops: true }, "sleep summaries"), /Unexpected Garmin response for sleep summaries/);
  assert.throws(() => parseResponse(HrvSummariesSchema, { hrvSummaries: "no" }, "HRV"), /Unexpected Garmin response for HRV/);
});

// --- download destination policy (inside the primitive, so it cannot be bypassed) ---

function withZip() {
  const zip = new AdmZip();
  zip.addFile("a.fit", Buffer.from("FITDATA"));
  const body = zip.toBuffer();
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response(body); }) as typeof fetch;
}
const ctx = { token: async () => "t" };

test("download writes a private file inside the current directory", async () => {
  const cwd = scratch(); process.chdir(cwd); withZip();
  assert.equal(await downloadActivity(ctx, { id: "5", output: "run.fit" }), "Saved run.fit");
  assert.equal(readFileSync(join(cwd, "run.fit"), "utf8"), "FITDATA");
  assert.equal(mode(join(cwd, "run.fit")), 0o600);
  mkdirSync(join(cwd, "sub"));
  await downloadActivity(ctx, { id: "5", output: "sub/run.fit" });
  assert.ok(existsSync(join(cwd, "sub", "run.fit")));
  await downloadActivity(ctx, { id: "5" });
  assert.ok(existsSync(join(cwd, "activity-5.fit")));
});

test("a direct caller cannot bypass the destination policy", async () => {
  process.chdir(scratch()); withZip();
  for (const output of ["../escape.fit", "/tmp/escape.fit", "C:escape.fit", "con", "a/../../b.fit"]) {
    await assert.rejects(downloadActivity(ctx, { id: "5", output }), GarminError, output);
  }
  assert.equal(urls.length, 0, "refused before any network request");
});

test("a symlinked directory that leads outside the current directory is refused", async () => {
  const cwd = scratch(), outside = scratch();
  process.chdir(cwd); withZip();
  symlinkSync(outside, join(cwd, "link"));
  await assert.rejects(downloadActivity(ctx, { id: "5", output: "link/x.fit" }), /outside the current directory/);
  assert.deepEqual(readdirSync(outside), [], "nothing was written outside");
  assert.equal(urls.length, 0);
});

test("existing files are refused before the network call, and missing directories are explained", async () => {
  const cwd = scratch(); process.chdir(cwd); withZip();
  writeFileSync(join(cwd, "there.fit"), "mine");
  await assert.rejects(downloadActivity(ctx, { id: "5", output: "there.fit" }), /already exists/);
  await assert.rejects(downloadActivity(ctx, { id: "5", output: "nope/x.fit" }), /does not exist/);
  assert.equal(urls.length, 0);
  assert.equal(readFileSync(join(cwd, "there.fit"), "utf8"), "mine");
  void statSync;
});
