import { parse } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Only the API key is ever taken from a .env file. Copying the whole file into process.env would let a
// stray .env (for example in whatever directory an MCP client launches us from) set variables such as
// NODE_TLS_REJECT_UNAUTHORIZED for the process that holds the key.
const ALLOWED = ["GARMIN_PERSONAL_API_KEY"] as const;

/**
 * Read the allow-listed variables from `.env` in each given directory (first directory wins).
 * Real environment variables always win. The current working directory is deliberately NOT searched.
 */
export function loadEnv(...dirs: string[]): void {
  for (const dir of dirs) {
    let parsed: Record<string, string>;
    try { parsed = parse(readFileSync(resolve(dir, ".env"))); } catch { continue; } // missing or unreadable
    for (const name of ALLOWED) if (process.env[name] === undefined && parsed[name]) process.env[name] = parsed[name];
  }
}

export function requireApiKey(): string {
  const key = process.env.GARMIN_PERSONAL_API_KEY?.trim();
  if (!key) throw new Error("Set GARMIN_PERSONAL_API_KEY in the repo's .env file or the environment.");
  return key;
}
