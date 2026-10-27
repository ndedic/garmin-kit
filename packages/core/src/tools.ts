// Tool registry: the single source of truth. The CLI, the MCP server and the skill docs are all generated
// from these definitions. Each tool's input is a zod schema; the JSON Schema (MCP), the CLI flags/help and
// the validation all derive from it, and the schema is the only place the rules live.
import { access, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { analyse, summariseRecovery, type Lap, type RecordSample, type RunSummary } from "./analyse.js";
import { apiActivityZip, apiJson, type Context } from "./auth.js";
import { activityPath, bodyBatteryPath, dailySummariesPath, extractFit, heartRatePath, hrvPath, hrvSummariesPath, parseFit, runsPath, sleepPath, sleepSummariesPath } from "./client.js";
import { GarminError, errorMessage } from "./errors.js";
import { LapListSchema, RecordListSchema, RunListSchema, parseResponse } from "./schemas.js";

export type Surface = "cli" | "mcp";

export interface Tool {
  name: string; // snake_case; the MCP tool name
  cli: string; // CLI command
  aliases?: readonly string[];
  description: string;
  input: z.ZodObject;
  positional: readonly string[]; // CLI: input keys taken as bare arguments, in order
  surfaces: readonly Surface[];
  writes?: boolean; // creates local files; never advertised to models via the skill
  /** Validate untrusted input (argv or MCP arguments) and return the parsed value; throws GarminError. */
  validate(raw: unknown): unknown;
  /** Run with input that came from `validate`. */
  run(input: unknown, ctx: Context): Promise<unknown>;
}

interface ToolDef<S extends z.ZodObject> {
  name: string;
  cli: string;
  aliases?: readonly string[];
  description: string;
  input: S;
  positional?: readonly (keyof z.input<S> & string)[];
  surfaces: readonly Surface[];
  writes?: boolean;
  run(input: z.output<S>, ctx: Context): Promise<unknown>;
}

function formatIssues(error: z.ZodError, raw: Record<string, unknown>): string {
  return error.issues.map((issue) => {
    if (issue.code === "unrecognized_keys") return `Unknown option: ${issue.keys.join(", ")}`;
    const name = issue.path.join(".") || "input";
    if (issue.code === "invalid_type" && issue.path.length === 1 && raw[issue.path[0] as string] === undefined) return `Missing required ${name}`;
    return `${name} ${issue.message}`;
  }).join("; ");
}

export function parseInput<S extends z.ZodObject>(schema: S, raw: unknown): z.output<S> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new GarminError("Arguments must be an object.");
  const result = schema.safeParse(raw);
  if (!result.success) throw new GarminError(formatIssues(result.error, raw as Record<string, unknown>));
  return result.data;
}

function defineTool<S extends z.ZodObject>(def: ToolDef<S>): Tool {
  return {
    ...def,
    positional: def.positional ?? [],
    validate: (raw) => parseInput(def.input, raw),
    run: (input, ctx) => def.run(input as z.output<S>, ctx),
  };
}

// --- Shared input fields. ---

const DATE_MESSAGE = "must be a valid date in YYYY-MM-DD format";
const validCalendarDate = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const dateField = (description: string) =>
  z.string({ error: DATE_MESSAGE }).regex(/^\d{4}-\d{2}-\d{2}$/, DATE_MESSAGE).refine(validCalendarDate, DATE_MESSAGE).describe(description);

const ID_MESSAGE = "must be a positive integer activity ID";
const ActivityIdSchema = z.string({ error: ID_MESSAGE }).regex(/^[1-9]\d*$/, ID_MESSAGE);
const activity = ActivityIdSchema.describe("Garmin activity ID (from list_runs)");

const integer = (min: number, max: number) =>
  z.number({ error: "must be an integer" }).int("must be an integer").min(min, `must be between ${min} and ${max}`).max(max, `must be between ${min} and ${max}`);

// Destination policy for files we create: relative to the current directory, no parent traversal.
export const checkOutputPath = (value: string): boolean => !(isAbsolute(value) || value.split(/[\\/]+/).includes("..") || value.includes("\0"));

const dayInput = z.strictObject({
  date: dateField("Calendar date YYYY-MM-DD; defaults to today (sleep belongs to the date you woke up)").optional(),
});
const rangeInput = z.strictObject({
  startDate: dateField("First calendar date YYYY-MM-DD; defaults to 6 days before endDate").optional(),
  endDate: dateField("Last calendar date YYYY-MM-DD, inclusive; defaults to today").optional(),
}).refine((v) => !v.startDate || !v.endDate || v.startDate <= v.endDate, { path: ["startDate"], error: "must not be after endDate" });

// --- Orthogonal primitives: one job each, plain Node functions, no CLI/MCP knowledge. ---

export const listRuns = async (ctx: Context, opts: { limit?: number; date?: string } = {}) =>
  parseResponse(RunListSchema, await apiJson(ctx, runsPath(opts.limit ?? 5, opts.date)), "run list");

export const getActivity = async (ctx: Context, id: string) => apiJson(ctx, activityPath(id));

const fitFor = async (ctx: Context, id: string) => parseFit(extractFit(await apiActivityZip(ctx, id)));

export const getLaps = async (ctx: Context, id: string): Promise<{ activityId: string; laps: unknown[] }> => ({ activityId: id, laps: (await fitFor(ctx, id)).laps ?? [] });

/** Keep one sample per `everySeconds` by timestamp (falls back to position when timestamps are missing). */
export function downsample<T extends { timestamp?: unknown }>(records: T[], everySeconds: number): T[] {
  if (everySeconds <= 1) return records;
  const seconds = records.map((r) => (r.timestamp == null ? NaN : new Date(r.timestamp as string | Date).getTime() / 1000));
  if (seconds.some(Number.isNaN)) return records.filter((_, i) => i % everySeconds === 0);
  let last = -Infinity;
  return records.filter((_, i) => (seconds[i] - last >= everySeconds ? ((last = seconds[i]), true) : false));
}

export async function getRecords(ctx: Context, id: string, everySeconds = 1): Promise<{ activityId: string; records: unknown[] }> {
  const records = (await fitFor(ctx, id)).records ?? [];
  return { activityId: id, records: downsample(records as { timestamp?: unknown }[], everySeconds) };
}

export async function downloadActivity(ctx: Context, opts: { id: string; format?: "fit" | "zip" | "json"; output?: string }): Promise<string> {
  const format = opts.format ?? "fit";
  const output = opts.output ?? `activity-${opts.id}.${format}`;
  // Fail before the network round trip; the exclusive create below stays the authoritative check.
  if (await access(output).then(() => true, () => false)) throw new GarminError(`${output} already exists; refusing to overwrite it.`);
  const zip = await apiActivityZip(ctx, opts.id);
  let content: Buffer;
  if (format === "zip") content = zip;
  else {
    const fit = extractFit(zip);
    content = format === "fit" ? fit : Buffer.from(JSON.stringify(await parseFit(fit, true), null, 2) + "\n");
  }
  try {
    await writeFile(output, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new GarminError(`Could not save ${format.toUpperCase()} file: ${errorMessage(error)}`);
  }
  return `Saved ${output}`;
}

// --- Wellness primitives (read-only daily health data). ---

const localDate = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return localDate(d); };
const MAX_RANGE_DAYS = 90;

export interface DateRange { startDate?: string; endDate?: string }
export function resolveRange(range: DateRange = {}): { startDate: string; endDate: string } {
  const endDate = range.endDate ?? localDate(new Date());
  const startDate = range.startDate ?? shift(endDate, -6);
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
  if (days < 0) throw new GarminError("startDate must not be after endDate.");
  if (days >= MAX_RANGE_DAYS) throw new GarminError(`Date range is limited to ${MAX_RANGE_DAYS} days.`);
  return { startDate, endDate };
}
const today = (date?: string) => date ?? localDate(new Date());

export const getSleep = (ctx: Context, date?: string) => apiJson(ctx, sleepPath(today(date)));
export const getSleepSummaries = (ctx: Context, range?: DateRange) => { const r = resolveRange(range); return apiJson(ctx, sleepSummariesPath(r.startDate, r.endDate)); };
export const getHrv = (ctx: Context, date?: string) => apiJson(ctx, hrvPath(today(date)));
export const getHrvSummaries = (ctx: Context, range?: DateRange) => { const r = resolveRange(range); return apiJson(ctx, hrvSummariesPath(r.startDate, r.endDate)); };
export const getBodyBattery = (ctx: Context, range?: DateRange) => { const r = resolveRange(range); return apiJson(ctx, bodyBatteryPath(r.startDate, r.endDate)); };
export const getHeartRate = (ctx: Context, date?: string) => apiJson(ctx, heartRatePath(today(date)));
export const getDailySummaries = (ctx: Context, range?: DateRange) => { const r = resolveRange(range); return apiJson(ctx, dailySummariesPath(r.startDate, r.endDate)); };

// --- Composition: built only from the primitives above plus the pure `analyse` function. ---

export async function analyseRun(ctx: Context, id?: string) {
  const runs = await listRuns(ctx, { limit: 100 });
  const index = id ? runs.findIndex((r) => String(r.activityId) === id) : 0;
  const target = index >= 0 ? runs[index] : undefined;
  // The id from Garmin's list is re-validated before it selects a resource, same as one typed by the caller.
  const activityId = ActivityIdSchema.safeParse(id ?? (target ? String(target.activityId) : undefined));
  if (!activityId.success) throw new GarminError(id ? `activityId ${ID_MESSAGE}` : "No running activities found.");
  const previous = runs.filter((_, i) => i !== index && (index < 0 || i > index)).slice(0, 3);
  const [{ laps }, { records }, recovery] = await Promise.all([getLaps(ctx, activityId.data), getRecords(ctx, activityId.data), recoveryFor(ctx, target)]);
  return analyse(
    parseResponse(LapListSchema, laps, "laps") as Lap[],
    parseResponse(RecordListSchema, records, "records") as RecordSample[],
    (target as RunSummary | undefined) ?? { activityId: activityId.data },
    previous as RunSummary[],
    recovery,
  );
}

// Wellness is context, not the point: if any endpoint fails or has no data, analyse still works.
async function recoveryFor(ctx: Context, run: RunSummary | undefined) {
  const runDate = run?.startTimeLocal?.slice(0, 10);
  if (!run || !runDate) return null;
  const day = { startDate: runDate, endDate: runDate };
  const [sleep, hrv, bodyBattery, daily] = await Promise.allSettled([
    getSleepSummaries(ctx, day), getHrvSummaries(ctx, day), getBodyBattery(ctx, day),
    getDailySummaries(ctx, { startDate: shift(runDate, -7), endDate: runDate }),
  ]);
  const ok = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? r.value : undefined);
  return summariseRecovery({ runDate, runStartLocal: run.startTimeLocal, runStartMs: run.beginTimestamp, sleep: ok(sleep), hrv: ok(hrv), bodyBattery: ok(bodyBattery), daily: ok(daily) });
}

// --- Tool definitions: thin adapters from validated input to the functions above. ---

export const tools: readonly Tool[] = [
  defineTool({
    name: "list_runs", cli: "runs", surfaces: ["cli", "mcp"],
    description: "List recent running activities (raw Garmin summaries, newest first). Use to find activity IDs.",
    input: z.strictObject({
      limit: integer(1, 100).default(5).describe("How many runs to return"),
      date: dateField("Only runs on this calendar date, YYYY-MM-DD").optional(),
    }),
    run: (input, ctx) => listRuns(ctx, input),
  }),
  defineTool({
    name: "analyse_run", cli: "analyse", aliases: ["analyze"], surfaces: ["cli", "mcp"], positional: ["activityId"],
    description: "Compact summary of a run: totals, per-km splits, first/second-half pace and HR, HR drift, pacing label, comparison with the previous 3 runs, and recovery context (sleep, HRV, resting HR, Body Battery going into the run). Defaults to the latest run. Contains no name or GPS data. Best starting point for any question about a run.",
    input: z.strictObject({ activityId: ActivityIdSchema.describe("Garmin activity ID; omit for the latest run").optional() }),
    run: (input, ctx) => analyseRun(ctx, input.activityId),
  }),
  defineTool({
    name: "get_activity", cli: "activity", surfaces: ["cli", "mcp"], positional: ["activityId"],
    description: "Raw Garmin activity detail JSON. Verbose and includes location data; prefer analyse_run.",
    input: z.strictObject({ activityId: activity }),
    run: (input, ctx) => getActivity(ctx, input.activityId),
  }),
  defineTool({
    name: "get_laps", cli: "laps", surfaces: ["cli", "mcp"], positional: ["activityId"],
    description: "Parsed FIT lap messages for an activity (raw, verbose). Prefer analyse_run for splits.",
    input: z.strictObject({ activityId: activity }),
    run: (input, ctx) => getLaps(ctx, input.activityId),
  }),
  defineTool({
    name: "get_records", cli: "records", surfaces: ["cli", "mcp"], positional: ["activityId"],
    description: "Per-second FIT samples (HR, speed, altitude, GPS) for an activity. Very large; downsample with everySeconds.",
    input: z.strictObject({ activityId: activity, everySeconds: integer(1, 3600).default(1).describe("Keep one sample per N seconds") }),
    run: (input, ctx) => getRecords(ctx, input.activityId, input.everySeconds),
  }),
  defineTool({
    name: "get_sleep", cli: "sleep", surfaces: ["cli", "mcp"],
    description: "Detailed sleep for one night: duration, stages, sleep score, overnight HR/HRV/respiration. Large; use get_sleep_summaries for trends.",
    input: dayInput,
    run: (input, ctx) => getSleep(ctx, input.date),
  }),
  defineTool({
    name: "get_sleep_summaries", cli: "sleep-summaries", surfaces: ["cli", "mcp"],
    description: "Per-night sleep summaries over a date range (default last 7 days, max 90).",
    input: rangeInput,
    run: (input, ctx) => getSleepSummaries(ctx, input),
  }),
  defineTool({
    name: "get_hrv", cli: "hrv", surfaces: ["cli", "mcp"],
    description: "Overnight heart rate variability for one date: summary, status and readings.",
    input: dayInput,
    run: (input, ctx) => getHrv(ctx, input.date),
  }),
  defineTool({
    name: "get_hrv_summaries", cli: "hrv-summaries", surfaces: ["cli", "mcp"],
    description: "Daily HRV summaries over a date range (default last 7 days, max 90). Good for recovery trends.",
    input: rangeInput,
    run: (input, ctx) => getHrvSummaries(ctx, input),
  }),
  defineTool({
    name: "get_body_battery", cli: "body-battery", surfaces: ["cli", "mcp"],
    description: "Body Battery energy levels over a date range (default last 7 days, max 90).",
    input: rangeInput,
    run: (input, ctx) => getBodyBattery(ctx, input),
  }),
  defineTool({
    name: "get_heart_rate", cli: "heart-rate", surfaces: ["cli", "mcp"],
    description: "All-day heart rate for one date, including resting heart rate.",
    input: dayInput,
    run: (input, ctx) => getHeartRate(ctx, input.date),
  }),
  defineTool({
    name: "get_daily_summaries", cli: "daily-summaries", surfaces: ["cli", "mcp"],
    description: "Daily wellness summaries over a date range (default last 7 days, max 90): steps, resting HR, stress and more.",
    input: rangeInput,
    run: (input, ctx) => getDailySummaries(ctx, input),
  }),
  defineTool({
    name: "download_activity", cli: "download", surfaces: ["cli"], writes: true, positional: ["activityId"], // writes files: CLI only, user-invoked
    description: "Save an activity's FIT file (or Garmin's ZIP, or FIT parsed to JSON) to disk. Refuses to overwrite.",
    input: z.strictObject({
      activityId: activity,
      format: z.enum(["fit", "zip", "json"], { error: "must be one of: fit, zip, json" }).default("fit").describe("fit (unchanged), zip (Garmin's original), json (parsed FIT)"),
      output: z.string().min(1, "must not be empty").refine(checkOutputPath, "must be a relative path inside the current directory (no absolute paths or ..)").optional().describe("Destination file, relative to the current directory; default activity-ID.FORMAT"),
    }),
    run: (input, ctx) => downloadActivity(ctx, { id: input.activityId, format: input.format, output: input.output }),
  }),
];

export const toolByName = (name: string) => tools.find((t) => t.name === name);
