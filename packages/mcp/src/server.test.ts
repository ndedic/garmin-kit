import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tools, type Context, type Tool } from "@garmin-kit/core";
import { MAX_RESULT_CHARS, createServer } from "./server.js";

const writer = { ...tools[0], name: "danger", surfaces: ["mcp"] as const, writes: true } as Tool;

const ctx: Context = { token: async () => { throw new Error("no network in tests"); } };

async function connect(toolset: readonly Tool[] = tools) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(() => ctx, toolset).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]).text;

test("lists only MCP-exposed tools with JSON schemas", async () => {
  const { tools: listed } = await (await connect()).listTools();
  const names = listed.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "analyse_run", "get_activity", "get_body_battery", "get_daily_summaries", "get_heart_rate", "get_hrv", "get_hrv_summaries",
    "get_laps", "get_records", "get_sleep", "get_sleep_summaries", "list_runs",
  ]);
  assert.ok(!names.includes("download_activity"));
  const records = listed.find((t) => t.name === "get_records")!;
  assert.deepEqual(records.inputSchema.required, ["activityId"]);
  assert.equal((records.inputSchema.properties as any).everySeconds.maximum, 3600);
  assert.equal(records.annotations?.readOnlyHint, true);
});

test("validates arguments before running", async () => {
  const client = await connect();
  const bad = await client.callTool({ name: "list_runs", arguments: { limit: 500 } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /between 1 and 100/);
  const missing = await client.callTool({ name: "get_laps", arguments: {} });
  assert.match(text(missing), /Missing required activityId/);
  const unknown = await client.callTool({ name: "get_laps", arguments: { activityId: "1", extra: 1 } });
  assert.match(text(unknown), /Unknown option/);
});

test("refuses CLI-only and unknown tools", async () => {
  const result = await (await connect()).callTool({ name: "download_activity", arguments: { activityId: "1" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown tool/);
});

test("returns tool output as text and guards oversized results", async () => {
  const fake = (name: string, out: unknown): Tool => ({ ...tools[0], name, cli: name, description: name, surfaces: ["mcp"], validate: () => ({}), run: async () => out });
  const client = await connect([fake("small", { ok: true }), fake("big", "x".repeat(MAX_RESULT_CHARS + 1))]);
  assert.equal(text(await client.callTool({ name: "small", arguments: {} })), '{"ok":true}');
  const big = await client.callTool({ name: "big", arguments: {} });
  assert.equal(big.isError, true);
  assert.match(text(big), /too large/);
});

test("surfaces runtime failures as tool errors, not protocol errors", async () => {
  const result = await (await connect()).callTool({ name: "list_runs", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /no network in tests/);
});

test("a write-capable tool is never exposed, even if mislabelled as MCP", async () => {
  const client = await connect([...tools, writer]);
  const { tools: listed } = await client.listTools();
  assert.ok(!listed.some((t) => t.name === "danger"));
  assert.equal((await client.callTool({ name: "danger", arguments: {} })).isError, true);
});

test("error output is bounded and sanitised", async () => {
  const boom: Tool = { ...tools[0], name: "boom", surfaces: ["mcp"], validate: () => ({}), run: async () => { throw new Error("x\u001b[31m" + "y".repeat(5000)); } };
  const result = await (await connect([boom])).callTool({ name: "boom", arguments: {} });
  assert.equal(result.isError, true);
  assert.ok(text(result).length <= 2000);
  assert.ok(!text(result).includes("\u001b"));
});
