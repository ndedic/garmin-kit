#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capOutput, createContext, errorMessage, loadEnv, requireApiKey, serialize } from "@garmin-kit/core";
import { parseArgs, usage } from "./args.js";

// Only GARMIN_PERSONAL_API_KEY is read from the repo's own .env (never the current directory's).
loadEnv(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unlimited = argv.includes("--no-limit");
  const parsed = parseArgs(argv.filter((arg) => arg !== "--no-limit"));
  if (parsed.kind === "help") { console.log(usage); return; }
  const result = await parsed.tool.run(parsed.input, createContext(requireApiKey()));
  const text = serialize(result, true); // control characters from provider data are neutralised
  // The CLI is on the model-facing path too (the skill), so it has the same output cap as the MCP server.
  console.log(capOutput(text, unlimited));
}

main().catch((error: unknown) => {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
