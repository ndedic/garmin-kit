import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadEnv } from "./env.js";

const SAVED = { ...process.env };
const dirWith = (contents: string) => { const d = mkdtempSync(join(tmpdir(), "gk-env-")); writeFileSync(join(d, ".env"), contents); return d; };
beforeEach(() => { for (const k of ["GARMIN_PERSONAL_API_KEY", "GK_MARKER", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete process.env[k]; });
afterEach(() => { process.env = { ...SAVED }; });

test("takes only the allow-listed key from .env", () => {
  const dir = dirWith("GARMIN_PERSONAL_API_KEY=k1\nGK_MARKER=x\nNODE_TLS_REJECT_UNAUTHORIZED=0\n");
  loadEnv(dir);
  assert.equal(process.env.GARMIN_PERSONAL_API_KEY, "k1");
  assert.equal(process.env.GK_MARKER, undefined);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

test("real environment wins, and the first directory wins", () => {
  process.env.GARMIN_PERSONAL_API_KEY = "from-env";
  loadEnv(dirWith("GARMIN_PERSONAL_API_KEY=file\n"));
  assert.equal(process.env.GARMIN_PERSONAL_API_KEY, "from-env");

  delete process.env.GARMIN_PERSONAL_API_KEY;
  loadEnv(dirWith("GARMIN_PERSONAL_API_KEY=first\n"), dirWith("GARMIN_PERSONAL_API_KEY=second\n"));
  assert.equal(process.env.GARMIN_PERSONAL_API_KEY, "first");
});

test("never reads the current working directory's .env", () => {
  const cwd = process.cwd();
  process.chdir(dirWith("GARMIN_PERSONAL_API_KEY=from-cwd\nGK_MARKER=x\n"));
  try { loadEnv("/nonexistent"); } finally { process.chdir(cwd); }
  assert.equal(process.env.GARMIN_PERSONAL_API_KEY, undefined);
  assert.equal(process.env.GK_MARKER, undefined);
});
