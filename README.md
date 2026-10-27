# garmin-kit

A read-only CLI for the [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-faq/), plus a Claude Code skill so you can just say **"analyse my last run"**.

- Requires Node.js 20+ and a Garmin Connect Personal API key.
- Read-only: it never writes to your Garmin account.
- Your key is read from the environment or the repo's `.env` and is never printed or written anywhere else. It is exchanged for a 24-hour access token, which is cached (see [Security notes](#security-notes)).

## Install

```sh
git clone https://github.com/ndedic/garmin-kit.git
cd garmin-kit
npm install
npm run build
npm link                      # puts `garmin` on your PATH
cp .env.example .env          # then put your key in .env
```

Create the key on Garmin Connect web under **Profile & Account → Settings → Personal API Key**. `.env` is git-ignored, and an existing `GARMIN_PERSONAL_API_KEY` environment variable takes precedence. The CLI and MCP server read **only** `GARMIN_PERSONAL_API_KEY`, and only from the repo's own `.env`; a `.env` in whatever directory you run from is deliberately ignored. Run `chmod 600 .env`.

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
garmin download 123456789 [--format fit|zip|json] [--output FILE]   # --output must be relative, no ..

# wellness (date defaults to today; ranges to the last 7 days, max 90)
garmin sleep [--date YYYY-MM-DD]
garmin sleep-summaries [--start-date D] [--end-date D]
garmin hrv [--date D]  |  garmin hrv-summaries [--start-date D] [--end-date D]
garmin body-battery [--start-date D] [--end-date D]
garmin heart-rate [--date D]            # includes resting heart rate
garmin daily-summaries [--start-date D] [--end-date D]
```

Activity IDs come from `runs` / `last-run`. `download` refuses to overwrite an existing file.

### `garmin analyse`

About 90 lines of JSON designed for people and LLMs:

- totals (distance, duration, pace, HR, cadence in steps per minute, elevation, training load)
- per-km splits with pace, HR, cadence and power
- first-half vs second-half pace and HR, pacing label (negative / even / positive split) and HR drift
- comparison against your previous 3 runs
- **recovery** going into the run: sleep hours and score, HRV against your baseline, resting HR against the previous week, and Body Battery at the start and its drop from the run (best effort: any part Garmin has no data for is simply omitted)

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

The same tools are available over MCP (stdio), which also works in Claude Desktop and any other MCP client. Tools exposed: `list_runs`, `analyse_run`, `get_activity`, `get_laps`, `get_records`, plus the wellness tools `get_sleep`, `get_sleep_summaries`, `get_hrv`, `get_hrv_summaries`, `get_body_battery`, `get_heart_rate` and `get_daily_summaries`. All are read-only. `download_activity` is CLI-only because it writes files. Results over 200,000 characters are refused with a hint to narrow the request.

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

1. **Orthogonal primitives**: plain async Node functions that each do one job and know nothing about any interface: `listRuns`, `getActivity`, `getLaps`, `getRecords`, `downloadActivity` and the wellness readers (`getSleep`, `getHrvSummaries`, `getBodyBattery`, `getHeartRate`, ...). `analyseRun` only composes them with the pure `analyse()` function.
2. **Tool definitions**: plain data (name, description, params, which surfaces expose it) plus a thin adapter to the function above.

The CLI, the MCP server and the skill docs are all derived from the definitions, so a new tool is written once:

| Surface | How it's derived |
|---|---|
| CLI | command, flags, validation and `--help` from `params` (`packages/cli`) |
| MCP | each tool with `"mcp"` in `surfaces`, params mapped to JSON schema (`toJsonSchema`); `download_activity` stays CLI-only because it writes files (`packages/mcp`) |
| Skill | `npm run gen:skill` rewrites the tool list in `skills/garmin/SKILL.md`; `npm run check:skill` fails if it is stale. Tools flagged `writes` (download) are left out so the model never offers to write files |

To add a tool: write the function, add a definition to `tools`, run `npm run build && npm run gen:skill`.

## Development

```sh
npm run build        # tsc -b across packages
npm test             # node:test via tsx (includes MCP server tests over an in-memory transport)
npm run smoke:mcp    # live stdio check against the real API
npm run gen:skill    # refresh the skill's tool list
npm run check:skill  # CI check that it is up to date
```

## Security notes

- **Token cache.** The 24-hour access token is cached in `~/.config/garmin/connect-personal-api-bearer-token.json` (directory `0700`, file `0600`), the same location and format as Garmin's own [`garmin-personal-api`](https://github.com/garmin/connect-personal-api-python) client, so both share it. It is reused while more than an hour remains, is tied to your key by a SHA-256 fingerprint (the key itself is never stored), and is refreshed automatically after a 401. Delete the file to force a new exchange. Revoking your key on Garmin Connect invalidates it.
- **Environment.** Only `GARMIN_PERSONAL_API_KEY` is read from a `.env` file, and only from the repo's own. Other variables in it, and any `.env` in the current directory, are ignored.
- **Network.** The only peer is `https://personal.connectapi.garmin.com`. Redirects are never followed, so the key and token cannot be sent elsewhere.
- **Files.** `download` is the only command that writes files. It is CLI-only, is not offered by the skill or MCP server, refuses to overwrite, creates files `0600`, and accepts only relative `--output` paths without `..`. Downloaded `activity-*` files are git-ignored.

## Privacy

Personal-API data includes health metrics and GPS tracks. Sleep, HRV, heart rate and Body Battery are health data too. Keep `.env` private, and be careful where you paste raw `activity`, `laps`, `records` or wellness output.
