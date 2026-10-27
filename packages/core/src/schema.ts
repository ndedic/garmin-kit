import { z } from "zod";
import type { Tool } from "./tools.js";

export type JsonSchema = Record<string, any>;
const cache = new WeakMap<Tool, JsonSchema>();

/** JSON Schema for a tool's input, derived from its zod schema (MCP inputSchema, CLI help and coercion). */
export function inputSchema(tool: Tool): JsonSchema {
  let schema = cache.get(tool);
  if (!schema) {
    schema = z.toJSONSchema(tool.input, { io: "input" }) as JsonSchema;
    delete schema.$schema;
    cache.set(tool, schema);
  }
  return schema;
}

/** @deprecated kept for callers of the old name */
export const toJsonSchema = inputSchema;

export const flagName = (key: string) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const placeholder = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

/** `garmin records ACTIVITY_ID [--every-seconds N]`: used by --help and the generated skill. */
export function commandLine(tool: Tool): string {
  const { properties = {}, required = [] } = inputSchema(tool);
  const isRequired = new Set<string>(required);
  const parts = [tool.cli];
  for (const key of tool.positional) parts.push(isRequired.has(key) ? placeholder(key) : `[${placeholder(key)}]`);
  for (const [key, prop] of Object.entries<JsonSchema>(properties)) {
    if (tool.positional.includes(key)) continue;
    const value = prop.enum ? prop.enum.join("|") : prop.type === "integer" || prop.type === "number" ? "N" : placeholder(key);
    parts.push(isRequired.has(key) ? `${flagName(key)} ${value}` : `[${flagName(key)} ${value}]`);
  }
  return `garmin ${parts.join(" ")}`;
}
