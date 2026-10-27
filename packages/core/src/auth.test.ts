import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { apiJson, createContext, getAccessToken } from "./auth.js";
import { GarminError } from "./errors.js";

const realFetch = globalThis.fetch;
let calls: { url: string; auth?: string; redirect?: string }[] = [];
let handler: (url: string, n: number) => Response;
let cacheFile: string;

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const nowS = () => Date.now() / 1000;

beforeEach(() => {
  calls = [];
  cacheFile = join(mkdtempSync(join(tmpdir(), "gk-auth-")), "sub", "token.json");
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>)?.Authorization, redirect: init.redirect });
    return handler(url, calls.length);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const tokenCalls = () => calls.filter((c) => c.url.includes("personalapitoken"));

test("exchanges the key once, caches the token with owner-only permissions, and reuses it", async () => {
  const token = jwt(nowS() + 24 * 3600);
  handler = () => new Response(token);
  assert.equal(await getAccessToken("key-1", { cacheFile }), token);
  assert.equal(await getAccessToken("key-1", { cacheFile }), token);
  assert.equal(tokenCalls().length, 1);
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(cacheFile, "..")).mode & 0o777, 0o700);
  assert.ok(!readFileSync(cacheFile, "utf8").includes("key-1"), "the API key must never be written to the cache");
});

test("never follows redirects", async () => {
  handler = () => new Response(jwt(nowS() + 24 * 3600));
  await getAccessToken("k", { cacheFile: null });
  assert.equal(calls[0].redirect, "error");
});

test("re-exchanges when the token has an hour or less left", async () => {
  handler = () => new Response(jwt(nowS() + 30 * 60));
  await getAccessToken("k", { cacheFile });
  await getAccessToken("k", { cacheFile });
  assert.equal(tokenCalls().length, 2);
});

test("a different key does not reuse the cached token", async () => {
  handler = () => new Response(jwt(nowS() + 24 * 3600));
  await getAccessToken("key-a", { cacheFile });
  await getAccessToken("key-b", { cacheFile });
  assert.equal(tokenCalls().length, 2);
});

test("ignores a corrupt cache and works with caching disabled", async () => {
  handler = () => new Response(jwt(nowS() + 24 * 3600));
  await getAccessToken("k", { cacheFile }); // creates the directory
  writeFileSync(cacheFile, "{not json");
  await getAccessToken("k", { cacheFile });
  assert.equal(tokenCalls().length, 2);
  await getAccessToken("k", { cacheFile: null });
  assert.equal(tokenCalls().length, 3);
});

test("a failed exchange is not remembered by the context", async () => {
  let fail = true;
  handler = () => (fail ? new Response("nope", { status: 503 }) : new Response(jwt(nowS() + 24 * 3600)));
  const ctx = createContext("k", { cacheFile: null });
  await assert.rejects(ctx.token(), GarminError);
  fail = false;
  assert.match(await ctx.token(), /^h\./);
});

test("a 401 on an API call triggers one fresh token exchange and a retry", async () => {
  const stale = jwt(nowS() + 24 * 3600), fresh = jwt(nowS() + 24 * 3600 + 5);
  let tokens = 0;
  handler = (url) => {
    if (url.includes("personalapitoken")) return new Response(++tokens === 1 ? stale : fresh);
    return calls.at(-1)!.auth === `Bearer ${stale}` ? new Response("", { status: 401 }) : new Response('{"ok":true}');
  };
  const ctx = createContext("k", { cacheFile });
  assert.deepEqual(await apiJson(ctx, "/x"), { ok: true });
  assert.equal(tokens, 2);
});

test("empty response bodies are null, and non-401 errors are not retried", async () => {
  handler = (url) => (url.includes("personalapitoken") ? new Response(jwt(nowS() + 24 * 3600)) : new Response("", { status: 200 }));
  assert.equal(await apiJson(createContext("k", { cacheFile: null }), "/empty"), null);
  handler = (url) => (url.includes("personalapitoken") ? new Response(jwt(nowS() + 24 * 3600)) : new Response("", { status: 404 }));
  const before = tokenCalls().length;
  await assert.rejects(apiJson(createContext("k", { cacheFile: null }), "/missing"), /404/);
  assert.equal(tokenCalls().length - before, 1);
});
