// Live smoke test: spawns the built MCP server over stdio and calls tools against the real API.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["packages/mcp/dist/index.js"], env: { ...process.env, PATH: process.env.PATH ?? "" } }));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const analysis = await client.callTool({ name: "analyse_run", arguments: {} });
const parsed = JSON.parse(analysis.content[0].text);
console.log("analyse_run:", analysis.isError ? "ERROR" : "ok", parsed.date_local, parsed.distance_km + " km", parsed.avg_pace_min_per_km + "/km", "keys:", Object.keys(parsed).length);
const records = await client.callTool({ name: "get_records", arguments: { activityId: String(parsed.activity_id), everySeconds: 300 } });
console.log("get_records(300s):", records.isError ? "ERROR " + records.content[0].text : JSON.parse(records.content[0].text).records.length + " samples");
const bad = await client.callTool({ name: "get_laps", arguments: { activityId: "1" } });
console.log("get_laps(1):", bad.isError ? "isError, " + bad.content[0].text : "unexpected success");
await client.close();
