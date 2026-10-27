// Tool registry: the single source of truth. The CLI, the MCP server and the skill docs are all
// generated from these definitions. Params are plain data so any surface can map them
// (argv flags, JSON schema, markdown) without core depending on a CLI or MCP library.
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { analyse, summariseRecovery, type Lap, type RecordSample, type RunSummary } from "./analyse.js";
import { apiActivityZip, apiJson, type Context } from "./auth.js";
import { activityPath, bodyBatteryPath, dailySummariesPath, extractFit, heartRatePath, hrvPath, hrvSummariesPath, parseFit, runsPath, sleepPath, sleepSummariesPath } from "./client.js";
import { GarminError, errorMessage } from "./errors.js";

export interface ParamSpec {
  name: string; // camelCase; the CLI flag is --kebab-case
  type: "string" | "integer";
  description: string;
  required?: boolean;
  positional?: boolean; // CLI: bare argument, taken in declaration order
  default?: string | number;
  enum?: readonly string[];
  min?: number;
  max?: number;
  pattern?: string; // regex source (also usable in JSON schema)
  invalid?: string; // message when pattern/check fails
  check?: (value: string) => string | undefined; // extra server-side validation
}

export type Input = Record<string, string | number | undefined>;
export type Surface = "cli" | "mcp";

export interface Tool {
  name: string; // snake_case; the MCP tool name
  cli: string; // CLI command
  aliases?: readonly string[];
  description: string;
  params: readonly ParamSpec[];
  surfaces: readonly Surface[];
  writes?: boolean; // creates local files; never advertised to models via the skill
  run(input: Input, ctx: Context): Promise<unknown>;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
export const flagName = (param: ParamSpec) => `--${kebab(param.name)}`;

export function validateInput(tool: Tool, raw: Record<string, unknown>): Input {
  const known = new Set(tool.params.map((p) => p.name));
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new GarminError(`Unknown option: ${key}`);
  const out: Input = {};
  for (const p of tool.params) {
    const value = raw[p.name];
    if (value === undefined || value === "") {
      if (p.required) throw new GarminError(`Missing required ${p.name}: ${p.description}`);
      if (p.default !== undefined) out[p.name] = p.default;
      continue;
    }
    if (p.type === "integer") {
      const n = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n)) throw new GarminError(`${p.name} must be an integer.`);
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) throw new GarminError(`${p.name} must be between ${p.min ?? "-∞"} and ${p.max ?? "∞"}.`);
      out[p.name] = n;
      continue;
    }
    if (typeof value !== "string") throw new GarminError(`${p.name} must be a string.`);
    if (p.enum && !p.enum.includes(value)) throw new GarminError(`${p.name} must be one of: ${p.enum.join(", ")}.`);
    if (p.pattern && !new RegExp(p.pattern).test(value)) throw new GarminError(p.invalid ?? `${p.name} is invalid.`);
    const problem = p.check?.(value);
    if (problem) throw new GarminError(problem);
    out[p.name] = value;
  }
  return out;
}

// Destination policy for files we create: relative to the current directory, no parent traversal.
export const checkOutputPath = (v: string): string | undefined =>
  isAbsolute(v) || v.split(/[\\/]+/).includes("..") || v.includes("\0") ? "output must be a relative path inside the current directory (no absolute paths or ..)." : undefined;

const activityId: ParamSpec = {
  name: "activityId", type: "string", required: true, positional: true,
  description: "Garmin activity ID (from list_runs / get_last_run)",
  pattern: "^[1-9]\\d*$", invalid: "activityId must be a positive integer activity ID.",
};

const dateParam = (name: string, description: string): ParamSpec => ({
  name, type: "string", description,
  pattern: "^\\d{4}-\\d{2}-\\d{2}$", invalid: `${name} must be a valid date in YYYY-MM-DD format.`,
  check: (v) => (new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? undefined : `${name} must be a valid date in YYYY-MM-DD format.`),
});
const date = dateParam("date", "Only runs on this calendar date, YYYY-MM-DD");
const dayParam = dateParam("date", "Calendar date YYYY-MM-DD; defaults to today (sleep belongs to the date you woke up)");
const rangeParams = [
  dateParam("startDate", "First calendar date YYYY-MM-DD; defaults to 6 days before endDate"),
  dateParam("endDate", "Last calendar date YYYY-MM-DD, inclusive; defaults to today"),
];

// --- Orthogonal primitives: one job each, plain Node functions, no CLI/MCP knowledge. ---

export const listRuns = async (ctx: Context, opts: { limit?: number; date?: string } = {}) =>
  apiJson(ctx, runsPath(opts.limit ?? 5, opts.date));

export const getActivity = async (ctx: Context, id: string) => apiJson(ctx, activityPath(id));

const fitFor = async (ctx: Context, id: string) => parseFit(extractFit(await apiActivityZip(ctx, id)));

export const getLaps = async (ctx: Context, id: string): Promise<{ activityId: string; laps: unknown[] }> => ({ activityId: id, laps: (await fitFor(ctx, id)).laps ?? [] });

export async function getRecords(ctx: Context, id: string, everySeconds = 1): Promise<{ activityId: string; records: unknown[] }> {
  const records = (await fitFor(ctx, id)).records ?? [];
  return { activityId: id, records: everySeconds > 1 ? records.filter((_, i) => i % everySeconds === 0) : records };
}

export async function downloadActivity(ctx: Context, opts: { id: string; format?: "fit" | "zip" | "json"; output?: string }): Promise<string> {
  const format = opts.format ?? "fit";
  const output = opts.output ?? `activity-${opts.id}.${format}`;
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
  const runs = (await listRuns(ctx, { limit: 100 })) as RunSummary[];
  const index = id ? runs.findIndex((r) => String(r.activityId) === id) : 0;
  const target = index >= 0 ? runs[index] : undefined;
  const activity = id ?? (target ? String(target.activityId) : undefined);
  if (!activity) throw new GarminError("No running activities found.");
  const previous = runs.filter((_, i) => i !== index && (index < 0 || i > index)).slice(0, 3);
  const [{ laps }, { records }, recovery] = await Promise.all([getLaps(ctx, activity), getRecords(ctx, activity), recoveryFor(ctx, target)]);
  return analyse(laps as Lap[], records as RecordSample[], target ?? { activityId: activity }, previous, recovery);
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

const idOf = (input: Input) => input.activityId as string;

export const tools: readonly Tool[] = [
  {
    name: "list_runs", cli: "runs", surfaces: ["cli", "mcp"],
    description: "List recent running activities (raw Garmin summaries, newest first). Use to find activity IDs.",
    params: [
      { name: "limit", type: "integer", description: "How many runs to return", default: 5, min: 1, max: 100 },
      date,
    ],
    run: (input, ctx) => listRuns(ctx, { limit: input.limit as number, date: input.date as string | undefined }),
  },
  {
    name: "analyse_run", cli: "analyse", aliases: ["analyze"], surfaces: ["cli", "mcp"],
    description: "Compact summary of a run: totals, per-km splits, first/second-half pace and HR, HR drift, pacing label, comparison with the previous 3 runs, and recovery context (sleep, HRV, resting HR, Body Battery going into the run). Defaults to the latest run. Contains no name or GPS data. Best starting point for any question about a run.",
    params: [{ ...activityId, required: false, description: "Garmin activity ID; omit for the latest run" }],
    run: (input, ctx) => analyseRun(ctx, input.activityId as string | undefined),
  },
  {
    name: "get_activity", cli: "activity", surfaces: ["cli", "mcp"],
    description: "Raw Garmin activity detail JSON. Verbose and includes location data; prefer analyse_run.",
    params: [activityId],
    run: (input, ctx) => getActivity(ctx, idOf(input)),
  },
  {
    name: "get_laps", cli: "laps", surfaces: ["cli", "mcp"],
    description: "Parsed FIT lap messages for an activity (raw, verbose). Prefer analyse_run for splits.",
    params: [activityId],
    run: (input, ctx) => getLaps(ctx, idOf(input)),
  },
  {
    name: "get_records", cli: "records", surfaces: ["cli", "mcp"],
    description: "Per-second FIT samples (HR, speed, altitude, GPS) for an activity. Very large; downsample with everySeconds.",
    params: [
      activityId,
      { name: "everySeconds", type: "integer", description: "Keep one sample per N seconds", default: 1, min: 1, max: 3600 },
    ],
    run: (input, ctx) => getRecords(ctx, idOf(input), input.everySeconds as number),
  },
  {
    name: "get_sleep", cli: "sleep", surfaces: ["cli", "mcp"],
    description: "Detailed sleep for one night: duration, stages, sleep score, overnight HR/HRV/respiration. Large; use get_sleep_summaries for trends.",
    params: [dayParam],
    run: (input, ctx) => getSleep(ctx, input.date as string | undefined),
  },
  {
    name: "get_sleep_summaries", cli: "sleep-summaries", surfaces: ["cli", "mcp"],
    description: "Per-night sleep summaries over a date range (default last 7 days, max 90).",
    params: rangeParams,
    run: (input, ctx) => getSleepSummaries(ctx, { startDate: input.startDate as string | undefined, endDate: input.endDate as string | undefined }),
  },
  {
    name: "get_hrv", cli: "hrv", surfaces: ["cli", "mcp"],
    description: "Overnight heart rate variability for one date: summary, status and readings.",
    params: [dayParam],
    run: (input, ctx) => getHrv(ctx, input.date as string | undefined),
  },
  {
    name: "get_hrv_summaries", cli: "hrv-summaries", surfaces: ["cli", "mcp"],
    description: "Daily HRV summaries over a date range (default last 7 days, max 90). Good for recovery trends.",
    params: rangeParams,
    run: (input, ctx) => getHrvSummaries(ctx, { startDate: input.startDate as string | undefined, endDate: input.endDate as string | undefined }),
  },
  {
    name: "get_body_battery", cli: "body-battery", surfaces: ["cli", "mcp"],
    description: "Body Battery energy levels over a date range (default last 7 days, max 90).",
    params: rangeParams,
    run: (input, ctx) => getBodyBattery(ctx, { startDate: input.startDate as string | undefined, endDate: input.endDate as string | undefined }),
  },
  {
    name: "get_heart_rate", cli: "heart-rate", surfaces: ["cli", "mcp"],
    description: "All-day heart rate for one date, including resting heart rate.",
    params: [dayParam],
    run: (input, ctx) => getHeartRate(ctx, input.date as string | undefined),
  },
  {
    name: "get_daily_summaries", cli: "daily-summaries", surfaces: ["cli", "mcp"],
    description: "Daily wellness summaries over a date range (default last 7 days, max 90): steps, resting HR, stress and more.",
    params: rangeParams,
    run: (input, ctx) => getDailySummaries(ctx, { startDate: input.startDate as string | undefined, endDate: input.endDate as string | undefined }),
  },
  {
    name: "download_activity", cli: "download", surfaces: ["cli"], writes: true, // writes files: CLI only, user-invoked
    description: "Save an activity's FIT file (or Garmin's ZIP, or FIT parsed to JSON) to disk. Refuses to overwrite.",
    params: [
      activityId,
      { name: "format", type: "string", description: "fit (unchanged), zip (Garmin's original), json (parsed FIT)", default: "fit", enum: ["fit", "zip", "json"] },
      { name: "output", type: "string", description: "Destination file, relative to the current directory; default activity-ID.FORMAT", check: checkOutputPath },
    ],
    run: (input, ctx) => downloadActivity(ctx, { id: idOf(input), format: input.format as "fit" | "zip" | "json", output: input.output as string | undefined }),
  },
];

export const toolByName = (name: string) => tools.find((t) => t.name === name);
