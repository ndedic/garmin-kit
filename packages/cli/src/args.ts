import { GarminError, flagName, tools as allTools, validateInput, type Input, type Tool } from "@garmin-kit/core";

export type Parsed = { kind: "help" } | { kind: "tool"; tool: Tool; input: Input };

// CLI-only shorthands; core stays orthogonal (no duplicate "last run" tool).
const SUGAR: Record<string, string[]> = { "last-run": ["runs", "--limit", "1"] };

const placeholder = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

export function usageFor(tools: readonly Tool[] = allTools): string {
  const lines = tools.filter((t) => t.surfaces.includes("cli")).map((t) => {
    const args = t.params.map((p) => {
      if (p.positional) return p.required ? placeholder(p.name) : `[${placeholder(p.name)}]`;
      const values = p.enum ? p.enum.join("|") : p.type === "integer" ? "N" : placeholder(p.name);
      return `[${flagName(p)} ${values}]`;
    });
    return `  garmin ${[t.cli, ...args].join(" ")}\n      ${t.description.split(". ")[0].replace(/\.$/, "")}`;
  });
  return `Garmin Personal API CLI\n\n${lines.join("\n")}\n  garmin last-run\n      Shorthand for: garmin runs --limit 1\n\nResults are JSON. The date refers to the activity's calendar date.\n`;
}

export const usage = usageFor();

export function parseArgs(argv: string[], tools: readonly Tool[] = allTools): Parsed {
  let [command = "runs", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (SUGAR[command]) {
    if (rest.length) throw new GarminError(`${command} takes no options.\n${usage}`);
    [command, ...rest] = SUGAR[command];
  }
  const tool = tools.find((t) => t.surfaces.includes("cli") && (t.cli === command || t.aliases?.includes(command)));
  if (!tool) throw new GarminError(`Unknown command: ${command}\n${usage}`);

  const flags = new Map(tool.params.map((p) => [flagName(p), p]));
  const positionals = tool.params.filter((p) => p.positional);
  const raw: Record<string, string> = {};
  let next = 0;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const param = flags.get(token);
      if (!param) throw new GarminError(`Unknown option: ${token}\n${usage}`);
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new GarminError(`Missing value for ${token}.\n${usage}`);
      if (param.name in raw) throw new GarminError(`Option ${token} given more than once.`);
      raw[param.name] = value;
    } else {
      const param = positionals[next++];
      if (!param) throw new GarminError(`Unexpected argument: ${token}\n${usage}`);
      raw[param.name] = token;
    }
  }
  return { kind: "tool", tool, input: validateInput(tool, raw) };
}
