import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";

const fails = (args: string[], pattern: RegExp) => assert.throws(() => parseArgs(args), pattern);
const parse = (args: string[]) => {
  const parsed = parseArgs(args);
  if (parsed.kind !== "tool") throw new Error("expected a tool");
  return { tool: parsed.tool.name, input: parsed.input };
};

test("defaults to list_runs with limit 5", () => {
  assert.deepEqual(parse([]), { tool: "list_runs", input: { limit: 5 } });
});

test("last-run is sugar for runs --limit 1 and takes no options", () => {
  assert.deepEqual(parse(["last-run"]), { tool: "list_runs", input: { limit: 1 } });
  fails(["last-run", "--limit", "2"], /takes no options/);
});

test("runs validates limit and date", () => {
  assert.deepEqual(parse(["runs", "--limit", "3", "--date", "2026-10-20"]), { tool: "list_runs", input: { limit: 3, date: "2026-10-20" } });
  fails(["runs", "--limit", "0"], /between 1 and 100/);
  fails(["runs", "--limit", "101"], /between 1 and 100/);
  fails(["runs", "--limit", "x"], /must be an integer/);
  fails(["runs", "--date", "2026-02-30"], /valid date/);
  fails(["runs", "--limit"], /Missing value/);
  fails(["runs", "--nope", "1"], /Unknown option/);
  fails(["runs", "stray"], /Unexpected argument/);
});

test("activity commands require a positive numeric id", () => {
  assert.deepEqual(parse(["laps", "123"]), { tool: "get_laps", input: { activityId: "123" } });
  fails(["activity", "0"], /positive integer/);
  fails(["records", "abc"], /positive integer/);
  fails(["laps"], /Missing required activityId/);
  fails(["laps", "1", "2"], /Unexpected argument/);
});

test("records can be downsampled", () => {
  assert.deepEqual(parse(["records", "9"]).input, { activityId: "9", everySeconds: 1 });
  assert.deepEqual(parse(["records", "9", "--every-seconds", "30"]).input, { activityId: "9", everySeconds: 30 });
});

test("analyse id is optional and analyze is an alias", () => {
  assert.deepEqual(parse(["analyse"]), { tool: "analyse_run", input: {} });
  assert.deepEqual(parse(["analyze", "42"]), { tool: "analyse_run", input: { activityId: "42" } });
});

test("download defaults and options", () => {
  assert.deepEqual(parse(["download", "9"]).input, { activityId: "9", format: "fit" });
  assert.deepEqual(parse(["download", "9", "--format", "json", "--output", "r.json"]).input, { activityId: "9", format: "json", output: "r.json" });
  fails(["download", "9", "--format", "gpx"], /must be one of: fit, zip, json/);
  fails(["download", "9", "--format", "fit", "--format", "zip"], /more than once/);
  fails(["download", "9", "--output"], /Missing value/);
});

test("help and unknown commands", () => {
  assert.deepEqual(parseArgs(["--help"]), { kind: "help" });
  fails(["bogus"], /Unknown command/);
});
