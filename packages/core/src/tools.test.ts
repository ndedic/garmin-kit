import assert from "node:assert/strict";
import { test } from "node:test";
import { GarminError } from "./errors.js";
import { checkOutputPath, resolveRange, tools, validateInput } from "./tools.js";

test("output paths must be relative with no parent traversal", () => {
  for (const ok of ["run.fit", "out/run.fit", "./run.fit", "a..b.fit"]) assert.equal(checkOutputPath(ok), undefined, ok);
  for (const bad of ["../x", "a/../../x", "/tmp/x", "a\\..\\x", "x\0y"]) assert.match(checkOutputPath(bad)!, /relative path/, bad);
});

test("write-capable tools are flagged and CLI-only", () => {
  const writers = tools.filter((t) => t.writes);
  assert.deepEqual(writers.map((t) => t.name), ["download_activity"]);
  assert.ok(writers.every((t) => !t.surfaces.includes("mcp")));
});

test("download validates --output through the shared validator", () => {
  const download = tools.find((t) => t.name === "download_activity")!;
  assert.throws(() => validateInput(download, { activityId: "1", output: "../x" }), /relative path/);
  assert.deepEqual(validateInput(download, { activityId: "1", output: "x.fit" }), { activityId: "1", format: "fit", output: "x.fit" });
});

test("date ranges default to the last 7 days and are bounded", () => {
  const r = resolveRange({ endDate: "2026-10-25" });
  assert.deepEqual(r, { startDate: "2026-10-19", endDate: "2026-10-25" });
  assert.deepEqual(resolveRange({ startDate: "2026-10-25", endDate: "2026-10-25" }), { startDate: "2026-10-25", endDate: "2026-10-25" });
  assert.throws(() => resolveRange({ startDate: "2026-10-26", endDate: "2026-10-25" }), /not be after/);
  assert.throws(() => resolveRange({ startDate: "2026-01-01", endDate: "2026-10-25" }), GarminError);
});

test("wellness tools are exposed on both CLI and MCP", () => {
  const names = tools.filter((t) => t.surfaces.includes("mcp")).map((t) => t.name);
  for (const n of ["get_sleep", "get_sleep_summaries", "get_hrv", "get_hrv_summaries", "get_body_battery", "get_heart_rate", "get_daily_summaries"]) assert.ok(names.includes(n), n);
});
