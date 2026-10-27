import type { Tool } from "./tools.js";

export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

/** JSON Schema for a tool's input, derived from its plain-data params (used by the MCP server). */
export function toJsonSchema(tool: Tool): JsonSchema {
  const properties: JsonSchema["properties"] = {};
  for (const p of tool.params) {
    properties[p.name] = {
      type: p.type,
      description: p.description,
      ...(p.enum && { enum: [...p.enum] }),
      ...(p.min !== undefined && { minimum: p.min }),
      ...(p.max !== undefined && { maximum: p.max }),
      ...(p.pattern && { pattern: p.pattern }),
      ...(p.default !== undefined && { default: p.default }),
    };
  }
  return { type: "object", properties, required: tool.params.filter((p) => p.required).map((p) => p.name), additionalProperties: false };
}
