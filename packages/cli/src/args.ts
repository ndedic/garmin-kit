import { GarminError, commandLine, flagName, inputSchema, tools as allTools, type Tool } from "@garmin-kit/core";

export type Parsed = { kind: "help" } | { kind: "tool"; tool: Tool; input: unknown };

// CLI-only shorthands; core stays orthogonal (no duplicate "last run" tool).
const SUGAR: Record<string, string[]> = { "last-run": ["runs", "--limit", "1"] };

export function usageFor(tools: readonly Tool[] = allTools): string {
  const lines = tools.filter((t) => t.surfaces.includes("cli")).map((t) => `  ${commandLine(t)}\n      ${t.description.split(". ")[0].replace(/\.$/, "")}`);
  return `Garmin Personal API CLI\n\n${lines.join("\n")}\n  garmin last-run\n      Shorthand for: garmin runs --limit 1\n\nResults are JSON, limited to 200,000 characters unless you pass --no-limit. Dates are calendar dates (YYYY-MM-DD).\n`;
}

export const usage = usageFor();

export function parseArgs(argv: string[], tools: readonly Tool[] = allTools): Parsed {
  let [command = "runs", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (Object.hasOwn(SUGAR, command)) {
    if (rest.length) throw new GarminError(`${command} takes no options.\n${usage}`);
    [command, ...rest] = SUGAR[command];
  }
  const tool = tools.find((t) => t.surfaces.includes("cli") && (t.cli === command || t.aliases?.includes(command)));
  if (!tool) throw new GarminError(`Unknown command: ${command}\n${usage}`);

  const properties = inputSchema(tool).properties ?? {};
  const flags = new Map(Object.keys(properties).map((key) => [flagName(key), key]));
  const numeric = (key: string) => ["integer", "number"].includes(properties[key]?.type);
  const raw: Record<string, string | number> = {};
  const assign = (key: string, label: string, value: string) => {
    if (Object.hasOwn(raw, key)) throw new GarminError(`${label} given more than once.`);
    // argv is all strings; only a clean integer literal is converted, so "x" still fails the integer check.
    raw[key] = numeric(key) && /^-?\d+$/.test(value) ? Number(value) : value;
  };

  let next = 0;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const key = flags.get(token);
      if (!key) throw new GarminError(`Unknown option: ${token}\n${usage}`);
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new GarminError(`Missing value for ${token}.\n${usage}`);
      assign(key, token, value);
    } else {
      const key = tool.positional[next++];
      if (!key) throw new GarminError(`Unexpected argument: ${token}\n${usage}`);
      assign(key, key, token);
    }
  }
  return { kind: "tool", tool, input: tool.validate(raw) };
}
