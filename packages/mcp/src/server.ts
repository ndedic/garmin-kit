import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GarminError, errorMessage, toJsonSchema, tools as allTools, validateInput, type Context, type Tool } from "@garmin-kit/core";

// Raw per-second data can be enormous; fail with guidance instead of flooding the model's context.
export const MAX_RESULT_CHARS = 200_000;

export function createServer(getContext: () => Context, tools: readonly Tool[] = allTools): Server {
  const exposed = tools.filter((t) => t.surfaces.includes("mcp"));
  const server = new Server({ name: "garmin-kit", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t),
      annotations: { readOnlyHint: true, openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = exposed.find((t) => t.name === params.name);
    if (!tool) return fail(`Unknown tool: ${params.name}`);
    try {
      const result = await tool.run(validateInput(tool, params.arguments ?? {}), getContext());
      const text = typeof result === "string" ? result : JSON.stringify(result);
      if (text.length > MAX_RESULT_CHARS) return fail(`Result too large (${text.length} chars). Narrow the request, e.g. a larger everySeconds, or use analyse_run.`);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return fail(error instanceof GarminError ? error.message : `Unexpected error: ${errorMessage(error)}`);
    }
  });

  return server;
}

const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });
