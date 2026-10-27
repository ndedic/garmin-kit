import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GarminError } from "./errors.js";
import { base, getActivityZip, getJson, request } from "./client.js";

// Same location and format as Garmin's own personal-api client, so both share one token cache.
export const DEFAULT_TOKEN_CACHE = join(homedir(), ".config", "garmin", "connect-personal-api-bearer-token.json");
const REFRESH_WINDOW_SECONDS = 60 * 60; // reuse a cached token only while more than an hour remains
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

interface CachedToken { fingerprint: string; access_token: string; expires_at: number }
export interface TokenOptions { cacheFile?: string | null; force?: boolean; now?: () => number } // cacheFile: null disables the cache

// The cache is tied to one key + base URL, and never stores the key itself.
const fingerprint = (key: string) => createHash("sha256").update(`${base}\0${key}`).digest("hex");

function jwtExpiry(token: string): number | undefined {
  try {
    const exp = Number(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp);
    return Number.isFinite(exp) ? exp : undefined;
  } catch { return undefined; }
}

async function readCache(file: string, expected: string): Promise<CachedToken | undefined> {
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as Partial<CachedToken>;
    if (cached.fingerprint === expected && typeof cached.access_token === "string" && typeof cached.expires_at === "number") return cached as CachedToken;
  } catch { /* missing or corrupt: fetch a new token */ }
  return undefined;
}

async function writeCache(file: string, cached: CachedToken): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(cached), { mode: 0o600 });
    await chmod(file, 0o600); // writeFile's mode only applies when the file is created
  } catch { /* the cache is best effort; never fail a request because of it */ }
}

export async function getAccessToken(key: string, options: TokenOptions = {}): Promise<string> {
  const cacheFile = options.cacheFile === undefined ? DEFAULT_TOKEN_CACHE : options.cacheFile;
  const now = options.now ?? (() => Date.now() / 1000);
  const fp = fingerprint(key);
  if (cacheFile && !options.force) {
    const cached = await readCache(cacheFile, fp);
    if (cached && cached.expires_at - now() > REFRESH_WINDOW_SECONDS) return cached.access_token;
  }
  const token = (await request(TOKEN_PATH, { method: "POST", headers: { Authorization: `ApiKey ${key}`, Accept: "*/*" } })).toString("utf8").trim();
  if (!token) throw new GarminError("Garmin returned an empty access token.");
  const expiresAt = jwtExpiry(token);
  if (cacheFile && expiresAt !== undefined) await writeCache(cacheFile, { fingerprint: fp, access_token: token, expires_at: expiresAt });
  return token;
}

export interface Context { token(force?: boolean): Promise<string> }

/** Context that exchanges the personal API key for an access token lazily, reusing the on-disk cache. */
export function createContext(key: string, options: Pick<TokenOptions, "cacheFile" | "now"> = {}): Context {
  let memo: Promise<string> | undefined;
  return {
    token(force = false) {
      if (force) memo = undefined;
      memo ??= getAccessToken(key, { ...options, force }).catch((error) => { memo = undefined; throw error; });
      return memo;
    },
  };
}

// A cached token can be revoked or expire early; retry once with a freshly exchanged one.
async function withAuth<T>(ctx: Context, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(await ctx.token());
  } catch (error) {
    if (error instanceof GarminError && error.status === 401) return call(await ctx.token(true));
    throw error;
  }
}

export const apiJson = (ctx: Context, path: string) => withAuth(ctx, (token) => getJson(token, path));
export const apiActivityZip = (ctx: Context, id: string) => withAuth(ctx, (token) => getActivityZip(token, id));
