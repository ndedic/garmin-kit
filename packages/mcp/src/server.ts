import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GarminError, MAX_RESULT_CHARS, OVERSIZE_HINT, errorMessage, inputSchema, sanitize, serialize, tools as allTools, type Context, type Tool } from "@garmin-kit/core";

export { MAX_RESULT_CHARS };
const MAX_ERROR_CHARS = 2_000;

export function createServer(getContext: () => Context, tools: readonly Tool[] = allTools): Server {
  const exposed = tools.filter((t) => t.surfaces.includes("mcp") && t.access === "read");
  const server = new Server({ name: "garmin-kit", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputSchema(t) as { type: "object"; properties?: Record<string, unknown> },
      annotations: { readOnlyHint: true, openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = exposed.find((t) => t.name === params.name);
    if (!tool) return fail(`Unknown tool: ${String(params.name).slice(0, 100)}`);
    try {
      const result = await tool.run(tool.validate(params.arguments ?? {}), getContext());
      const text = serialize(result);
      if (text.length > MAX_RESULT_CHARS) return fail(`Result too large (${text.length} chars). ${OVERSIZE_HINT}`);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return fail(error instanceof GarminError ? errorMessage(error) : `Unexpected error: ${errorMessage(error)}`);
    }
  });

  return server;
}

// Error text is sanitised (no control characters) and bounded, like successful output.
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: sanitize(message).slice(0, MAX_ERROR_CHARS) }] });
