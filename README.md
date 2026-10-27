# garmin-kit

A read-only CLI for the [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-faq/), plus a Claude Code skill so you can just say **"analyse my last run"**.

- Requires Node.js 20+ and a Garmin Connect Personal API key.
- Read-only: it never writes to your Garmin account.
- Your key is read from `.env` or the environment, exchanged for a short-lived token on each call, and never printed or cached.

## Install

```sh
git clone https://github.com/ndedic/garmin-kit.git
cd garmin-kit
npm install
npm run build
npm link                      # puts `garmin` on your PATH
cp .env.example .env          # then put your key in .env
```

Create the key on Garmin Connect web under **Profile & Account → Settings → Personal API Key**. `.env` is git-ignored, and an existing `GARMIN_PERSONAL_API_KEY` environment variable takes precedence. The CLI finds the project's `.env` from any directory.

If `garmin` isn't found after `npm link`, make sure your npm global bin directory is on `PATH` (`npm prefix -g`, then `bin/`).

## Commands

```sh
garmin analyse                 # compact summary of your latest run
garmin analyse 123456789       # ...or a specific activity
garmin last-run                # raw JSON for the latest run
garmin runs --limit 3
garmin runs --date 2026-10-20
garmin activity 123456789
garmin laps 123456789          # parsed from the FIT export
garmin records 123456789       # per-second samples (large!)
garmin download 123456789 [--format fit|zip|json] [--output FILE]
```

Activity IDs come from `runs` / `last-run`. `download` refuses to overwrite an existing file.

### `garmin analyse`

About 90 lines of JSON designed for people and LLMs:

- totals (distance, duration, pace, HR, cadence in steps per minute, elevation, training load)
- per-km splits with pace, HR, cadence and power
- first-half vs second-half pace and HR, pacing label (negative / even / positive split) and HR drift
- comparison against your previous 3 runs

Units are in the field names (`distance_km`, `pace_min_per_km`, `cadence_spm`). Name, GPS coordinates and profile images are deliberately left out. The other commands print raw Garmin JSON, which can contain private location and health data.

## Set up in Claude Code

The `skills/garmin` folder is a Claude Code skill. Install it for your user account:

```sh
mkdir -p ~/.claude/skills
cp -R skills/garmin ~/.claude/skills/garmin      # or: ln -s "$PWD/skills/garmin" ~/.claude/skills/garmin
```

Start a **new** Claude Code session (skills load at startup) from any directory and ask:

- "analyse my last run"
- "am I getting faster?"
- "how does my last run compare to the previous ones?"

Claude runs `garmin analyse`, reads the summary and reports a verdict with evidence. The skill tells it never to dump raw per-second records and not to speculate medically. Because the CLI is on your `PATH` and the key is in `.env`, you never need to give Claude a path or a key.

Troubleshooting:

| Symptom | Fix |
|---|---|
| Claude doesn't use the skill | Check `~/.claude/skills/garmin/SKILL.md` exists, then start a new session |
| `garmin: command not found` | Re-run `npm link`, or fix your npm global bin on `PATH` |
| `HTTP 401` | Key rejected: create a new key on Garmin Connect and update `.env` |
| `HTTP 429` | Rate limited: wait and retry (the CLI already retries twice) |

## Set up as an MCP server

The same tools are available over MCP (stdio), which also works in Claude Desktop and any other MCP client. Tools exposed: `list_runs`, `analyse_run`, `get_activity`, `get_laps`, `get_records`. All are read-only. `download_activity` is CLI-only because it writes files. Results over 200,000 characters are refused with a hint to narrow the request.

```sh
npm run build
claude mcp add garmin -- node "$PWD/packages/mcp/dist/index.js"
```

The server reads `GARMIN_PERSONAL_API_KEY` from the environment the client passes, and falls back to the repo's `.env`. To pass it explicitly add `-e GARMIN_PERSONAL_API_KEY=...`. For Claude Desktop add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-kit/packages/mcp/dist/index.js"],
      "env": { "GARMIN_PERSONAL_API_KEY": "your-key-here" }
    }
  }
}
```

Skill or MCP? The skill (CLI) is lighter for Claude Code. Use MCP for clients without a shell, such as Claude Desktop. You can have both installed.

Check it with `npm run smoke:mcp`, which starts the built server over stdio and calls the real API.

## Architecture

```
packages/
  core/   @garmin-kit/core   Garmin client, FIT parsing, run analysis, and the tool registry
  cli/    @garmin-kit/cli    `garmin` command, generated from the registry
  mcp/    @garmin-kit/mcp       MCP server (stdio), generated from the same registry
skills/garmin/                  Claude Code skill; its tool list is generated from the registry
scripts/gen-skill.ts            regenerates the skill's tool list
```

**Tools live in core.** `packages/core/src/tools.ts` has two layers:

1. **Orthogonal primitives**: plain async Node functions that each do one job and know nothing about any interface: `listRuns`, `getActivity`, `getLaps`, `getRecords`, `downloadActivity`. `analyseRun` only composes them with the pure `analyse()` function.
2. **Tool definitions**: plain data (name, description, params, which surfaces expose it) plus a thin adapter to the function above.

The CLI, the MCP server and the skill docs are all derived from the definitions, so a new tool is written once:

| Surface | How it's derived |
|---|---|
| CLI | command, flags, validation and `--help` from `params` (`packages/cli`) |
| MCP | each tool with `"mcp"` in `surfaces`, params mapped to JSON schema (`toJsonSchema`); `download_activity` stays CLI-only because it writes files (`packages/mcp`) |
| Skill | `npm run gen:skill` rewrites the tool list in `skills/garmin/SKILL.md`; `npm run check:skill` fails if it is stale |

To add a tool: write the function, add a definition to `tools`, run `npm run build && npm run gen:skill`.

## Development

```sh
npm run build        # tsc -b across packages
npm test             # node:test via tsx (includes MCP server tests over an in-memory transport)
npm run smoke:mcp    # live stdio check against the real API
npm run gen:skill    # refresh the skill's tool list
npm run check:skill  # CI check that it is up to date
```

## Privacy

Personal-API data includes health metrics and GPS tracks. Keep `.env` private, and be careful where you paste raw `activity`, `laps` or `records` output.
