// Tool registry: the single source of truth. The CLI, the MCP server and the skill docs are all
// generated from these definitions. Params are plain data so any surface can map them
// (argv flags, JSON schema, markdown) without core depending on a CLI or MCP library.
import { writeFile } from "node:fs/promises";
import { analyse, type Lap, type RecordSample, type RunSummary } from "./analyse.js";
import { activityPath, extractFit, getAccessToken, getActivityZip, getJson, parseFit, runsPath } from "./client.js";
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

export interface Context { token(): Promise<string> }

export interface Tool {
  name: string; // snake_case; the MCP tool name
  cli: string; // CLI command
  aliases?: readonly string[];
  description: string;
  params: readonly ParamSpec[];
  surfaces: readonly Surface[];
  run(input: Input, ctx: Context): Promise<unknown>;
}

/** Context that exchanges the personal API key for an access token once, lazily. */
export function createContext(key: string): Context {
  let token: Promise<string> | undefined;
  return { token: () => (token ??= getAccessToken(key)) };
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

const activityId: ParamSpec = {
  name: "activityId", type: "string", required: true, positional: true,
  description: "Garmin activity ID (from list_runs / get_last_run)",
  pattern: "^[1-9]\\d*$", invalid: "activityId must be a positive integer activity ID.",
};

const date: ParamSpec = {
  name: "date", type: "string", description: "Only runs on this calendar date, YYYY-MM-DD",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$", invalid: "date must be a valid date in YYYY-MM-DD format.",
  check: (v) => (new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? undefined : "date must be a valid date in YYYY-MM-DD format."),
};

// --- Orthogonal primitives: one job each, plain Node functions, no CLI/MCP knowledge. ---

export const listRuns = async (ctx: Context, opts: { limit?: number; date?: string } = {}) =>
  getJson(await ctx.token(), runsPath(opts.limit ?? 5, opts.date));

export const getActivity = async (ctx: Context, id: string) => getJson(await ctx.token(), activityPath(id));

const fitFor = async (ctx: Context, id: string) => parseFit(extractFit(await getActivityZip(await ctx.token(), id)));

export const getLaps = async (ctx: Context, id: string): Promise<{ activityId: string; laps: unknown[] }> => ({ activityId: id, laps: (await fitFor(ctx, id)).laps ?? [] });

export async function getRecords(ctx: Context, id: string, everySeconds = 1): Promise<{ activityId: string; records: unknown[] }> {
  const records = (await fitFor(ctx, id)).records ?? [];
  return { activityId: id, records: everySeconds > 1 ? records.filter((_, i) => i % everySeconds === 0) : records };
}

export async function downloadActivity(ctx: Context, opts: { id: string; format?: "fit" | "zip" | "json"; output?: string }): Promise<string> {
  const format = opts.format ?? "fit";
  const output = opts.output ?? `activity-${opts.id}.${format}`;
  const zip = await getActivityZip(await ctx.token(), opts.id);
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

// --- Composition: built only from the primitives above plus the pure `analyse` function. ---

export async function analyseRun(ctx: Context, id?: string) {
  const runs = (await listRuns(ctx, { limit: 100 })) as RunSummary[];
  const index = id ? runs.findIndex((r) => String(r.activityId) === id) : 0;
  const target = index >= 0 ? runs[index] : undefined;
  const activity = id ?? (target ? String(target.activityId) : undefined);
  if (!activity) throw new GarminError("No running activities found.");
  const previous = runs.filter((_, i) => i !== index && (index < 0 || i > index)).slice(0, 3);
  const [{ laps }, { records }] = await Promise.all([getLaps(ctx, activity), getRecords(ctx, activity)]);
  return analyse(laps as Lap[], records as RecordSample[], target ?? { activityId: activity }, previous);
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
    description: "Compact summary of a run: totals, per-km splits, first/second-half pace and HR, HR drift, pacing label, comparison with the previous 3 runs. Defaults to the latest run. Contains no name or GPS data. Best starting point for any question about a run.",
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
    name: "download_activity", cli: "download", surfaces: ["cli"], // writes files: CLI only
    description: "Save an activity's FIT file (or Garmin's ZIP, or FIT parsed to JSON) to disk. Refuses to overwrite.",
    params: [
      activityId,
      { name: "format", type: "string", description: "fit (unchanged), zip (Garmin's original), json (parsed FIT)", default: "fit", enum: ["fit", "zip", "json"] },
      { name: "output", type: "string", description: "Destination file; default activity-ID.FORMAT" },
    ],
    run: (input, ctx) => downloadActivity(ctx, { id: idOf(input), format: input.format as "fit" | "zip" | "json", output: input.output as string | undefined }),
  },
];

export const toolByName = (name: string) => tools.find((t) => t.name === name);
