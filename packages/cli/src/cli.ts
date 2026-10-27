#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, errorMessage, loadEnv, requireApiKey } from "@garmin-kit/core";
import { parseArgs, usage } from "./args.js";

// Works from any cwd: the repo root .env first, then ./.env. Real env vars still win.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv(repoRoot);

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") { console.log(usage); return; }
  const result = await parsed.tool.run(parsed.input, createContext(requireApiKey()));
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
