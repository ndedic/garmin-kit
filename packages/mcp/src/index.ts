#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext, loadEnv, requireApiKey } from "@garmin-kit/core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";

// The MCP client normally passes GARMIN_PERSONAL_API_KEY in `env`; fall back to the repo .env.
loadEnv(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));

// Created lazily so the server starts (and lists tools) even before the key is configured.
let context: ReturnType<typeof createContext> | undefined;
const getContext = () => (context ??= createContext(requireApiKey()));

// stdout carries the protocol; log to stderr only.
await createServer(getContext).connect(new StdioServerTransport());
console.error("garmin-kit MCP server running on stdio");
