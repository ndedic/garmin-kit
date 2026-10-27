import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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

// A cache we should neither trust nor touch: not a regular file (symlink, fifo...), owned by someone else,
// or readable by other users. (POSIX only; Windows has no meaningful mode bits here.)
async function isUntrusted(file: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  const info = await lstat(file).catch(() => undefined);
  if (!info) return false; // does not exist yet
  return !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0;
}

async function readCache(file: string, expected: string): Promise<CachedToken | undefined> {
  try {
    if (await isUntrusted(file)) return undefined; // fetch a fresh token; the write below replaces the file
    const cached = JSON.parse(await readFile(file, "utf8")) as Partial<CachedToken>;
    if (cached.fingerprint === expected && typeof cached.access_token === "string" && typeof cached.expires_at === "number") return cached as CachedToken;
  } catch { /* missing or corrupt: fetch a new token */ }
  return undefined;
}

// Write to a brand-new 0600 file and rename it over the cache. The token is never written into an inode that
// already existed (whatever its mode, or whoever already holds it open), and rename replaces a symlink itself
// instead of following it.
async function writeCache(file: string, cached: CachedToken): Promise<void> {
  const dir = dirname(file);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      const existing = await lstat(file).catch(() => undefined);
      if (existing && (!existing.isFile() || existing.uid !== process.getuid?.())) return; // not ours: do not cache
    }
    const handle = await open(tmp, "wx", 0o600); // O_EXCL: never reuses or follows anything
    try {
      await handle.writeFile(JSON.stringify(cached));
      await handle.chmod(0o600); // independent of the umask
    } finally { await handle.close(); }
    await rename(tmp, file);
  } catch {
    await unlink(tmp).catch(() => undefined); // the cache is best effort; never fail a request because of it
  }
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
  const token = await ctx.token(); // an auth failure here is final: never send the key a second time
  try {
    return await call(token);
  } catch (error) {
    if (error instanceof GarminError && error.status === 401) return call(await ctx.token(true));
    throw error;
  }
}

export const apiJson = (ctx: Context, path: string) => withAuth(ctx, (token) => getJson(token, path));
export const apiActivityZip = (ctx: Context, id: string) => withAuth(ctx, (token) => getActivityZip(token, id));
