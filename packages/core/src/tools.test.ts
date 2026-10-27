import assert from "node:assert/strict";
import { test } from "node:test";
import { GarminError } from "./errors.js";
import { inputSchema, commandLine } from "./schema.js";
import { checkOutputPath, downsample, previousRuns, recordsPage, resolveRange, tools } from "./tools.js";
import { serialize } from "./output.js";
import { MAX_RESULT_CHARS } from "./limits.js";

const tool = (name: string) => tools.find((t) => t.name === name)!;
const rejects = (name: string, raw: unknown, pattern: RegExp) => assert.throws(() => tool(name).validate(raw), (e) => e instanceof GarminError && pattern.test(e.message));

test("record pages reconstruct full-resolution data above the response cap", () => {
  const records = Array.from({ length: 1100 }, (_, i) => ({ timestamp: i, note: "\u009b".repeat(300) }));
  assert.ok(serialize(records).length > MAX_RESULT_CHARS);
  const collected: unknown[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = recordsPage("1", records, offset, 500);
    assert.ok(serialize(page).length <= MAX_RESULT_CHARS / 2);
    assert.equal(page.totalRecords, records.length);
    assert.ok(page.records.length > 0);
    collected.push(...page.records);
    if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.deepEqual(collected, records);
});

test("record pagination handles empty, exact and invalid boundaries", () => {
  assert.equal(recordsPage("1", []).nextOffset, null);
  assert.deepEqual(recordsPage("1", [1, 2], 2).records, []);
  assert.equal(recordsPage("1", [1, 2], 0, 2).nextOffset, null);
  for (const offset of [-1, 1.5, 3]) assert.throws(() => recordsPage("1", [1, 2], offset), /offset/);
  assert.throws(() => recordsPage("1", ["x".repeat(MAX_RESULT_CHARS)]), /Record at offset 0 exceeds/);
  rejects("get_records_page", { activityId: "1", offset: -1 }, /between/);
  rejects("get_records_page", { activityId: "1", limit: 501 }, /between/);
  assert.deepEqual(tool("get_records_page").validate({ activityId: "1" }), { activityId: "1", offset: 0, limit: 100 });
});

test("output paths must be relative with no parent traversal", () => {
  for (const ok of ["run.fit", "out/run.fit", "./run.fit", "a..b.fit"]) assert.equal(checkOutputPath(ok), true, ok);
  for (const bad of ["../x", "a/../../x", "/tmp/x", "a\\..\\x", "x\0y", "C:file.fit", "c:\\x", "con", "NUL.fit", "dir/aux.txt", "com1", "LPT9.fit"]) assert.equal(checkOutputPath(bad), false, bad);
});

test("only read-only tools can reach MCP or the skill; the single writer is CLI-only", () => {
  const writers = tools.filter((t) => t.access === "write");
  assert.deepEqual(writers.map((t) => t.name), ["download_activity"]);
  assert.ok(writers.every((t) => !t.surfaces.includes("mcp")));
  assert.ok(tools.every((t) => t.access === "read" || t.access === "write"), "every tool must declare its access");
});

test("download validates --output and format", () => {
  rejects("download_activity", { activityId: "1", output: "../x" }, /relative path/);
  rejects("download_activity", { activityId: "1", output: "" }, /must not be empty/);
  rejects("download_activity", { activityId: "1", format: "gpx" }, /must be one of: fit, zip, json/);
  assert.deepEqual(tool("download_activity").validate({ activityId: "1", output: "x.fit" }), { activityId: "1", format: "fit", output: "x.fit" });
});

test("calendar-invalid dates are a validation error, not a RangeError", () => {
  for (const bad of ["2026-13-01", "2026-02-30", "2026-00-10", "2026-04-31", "0050-01-01", "2026-1-1", "tomorrow"]) rejects("list_runs", { date: bad }, /valid date in YYYY-MM-DD/);
  for (const ok of ["2026-10-25", "2028-02-29"]) assert.deepEqual(tool("list_runs").validate({ date: ok }), { limit: 5, date: ok });
  rejects("get_sleep", { date: "2026-13-01" }, /valid date/);
});

test("input is strict: no coercion, no unknown keys, no wrong types", () => {
  rejects("list_runs", { limit: "3" }, /must be an integer/); // MCP sends real numbers; strings are only coerced by the CLI
  rejects("list_runs", { limit: 3.5 }, /must be an integer/);
  rejects("list_runs", { limit: 0 }, /between 1 and 100/);
  rejects("list_runs", { limit: 101 }, /between 1 and 100/);
  rejects("get_laps", { activityId: "1", extra: 1 }, /Unknown option: extra/);
  rejects("get_laps", { activityId: 5 }, /positive integer activity ID/);
  rejects("get_laps", { activityId: "0" }, /positive integer activity ID/);
  rejects("get_laps", {}, /Missing required activityId/);
  rejects("get_laps", null, /must be an object/);
  rejects("get_laps", ["1"], /must be an object/);
  rejects("get_records", { activityId: "1", everySeconds: 0 }, /between 1 and 3600/);
});

test("ranges are validated at the schema and bounded", () => {
  rejects("get_sleep_summaries", { startDate: "2026-10-26", endDate: "2026-10-25" }, /must not be after endDate/);
  assert.deepEqual(tool("get_sleep_summaries").validate({}), {});
  assert.deepEqual(resolveRange({ endDate: "2026-10-25" }), { startDate: "2026-10-19", endDate: "2026-10-25" });
  assert.throws(() => resolveRange({ startDate: "2026-01-01", endDate: "2026-10-25" }), /limited to 90 days/);
});

test("JSON Schema is derived from the zod input", () => {
  const runs = inputSchema(tool("list_runs"));
  assert.equal(runs.additionalProperties, false);
  assert.equal(runs.properties.limit.type, "integer");
  assert.deepEqual([runs.properties.limit.minimum, runs.properties.limit.maximum, runs.properties.limit.default], [1, 100, 5]);
  assert.equal(runs.properties.date.pattern, "^\\d{4}-\\d{2}-\\d{2}$");
  assert.deepEqual(runs.required ?? [], []); // defaulted and optional fields are not required
  assert.deepEqual(inputSchema(tool("get_records")).required, ["activityId"]);
  assert.deepEqual(inputSchema(tool("download_activity")).properties.format.enum, ["fit", "zip", "json"]);
  assert.equal(inputSchema(tool("get_laps")).$schema, undefined);
});

test("command lines are generated from the schema", () => {
  assert.equal(commandLine(tool("get_records")), "garmin records ACTIVITY_ID [--every-seconds N]");
  assert.equal(commandLine(tool("analyse_run")), "garmin analyse [ACTIVITY_ID]");
  assert.equal(commandLine(tool("download_activity")), "garmin download ACTIVITY_ID [--format fit|zip|json] [--output OUTPUT]");
});

test("every tool exposed to models is read-only and validates", () => {
  for (const t of tools.filter((x) => x.surfaces.includes("mcp"))) assert.equal(t.access, "read", t.name);
  const names = tools.filter((t) => t.surfaces.includes("mcp")).map((t) => t.name);
  for (const n of ["get_sleep", "get_sleep_summaries", "get_hrv", "get_hrv_summaries", "get_body_battery", "get_heart_rate", "get_daily_summaries"]) assert.ok(names.includes(n), n);
});

test("downsampling is by timestamp, not array position", () => {
  const at = (s: number) => ({ timestamp: new Date(Date.UTC(2026, 9, 25, 8, 0, s)) });
  // irregular sampling with a pause: 0,1,2, (pause) 60,61,62
  const records = [0, 1, 2, 60, 61, 62].map(at);
  assert.deepEqual(downsample(records, 30).map((r) => r.timestamp.getUTCSeconds() + r.timestamp.getUTCMinutes() * 60), [0, 60]);
  assert.equal(downsample(records, 1).length, 6);
  // without timestamps it falls back to position
  assert.equal(downsample([{}, {}, {}, {}, {}], 2).length, 3);
});

test("the previous-runs comparison only ever uses earlier runs", () => {
  const runs = ["newest", "r2", "r3", "r4", "r5"]; // newest first
  assert.deepEqual(previousRuns(runs, 0), ["r2", "r3", "r4"]);
  assert.deepEqual(previousRuns(runs, 3), ["r5"]);
  assert.deepEqual(previousRuns(runs, 4), []);
  assert.deepEqual(previousRuns(runs, -1), [], "a run outside the fetched window has no known earlier runs");
});
