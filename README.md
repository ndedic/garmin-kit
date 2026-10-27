# garmin-kit

Ask Claude about your own Garmin data: **"analyse my last run"**, **"how did I sleep?"**, **"is my HRV trending down?"**

garmin-kit is a small, read-only toolkit for the [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-faq/). It gives you the same tools three ways, all generated from one definition:

| You want | Use | Needs |
|---|---|---|
| To type commands yourself | the **CLI** (`garmin analyse`) | Node.js |
| Claude Code to answer questions about your runs | the **skill** (calls the CLI) | CLI on your `PATH` |
| Claude Desktop, or any MCP client | the **MCP server** | nothing else |

Everything is read-only: it never writes to your Garmin account.

## Requirements

- Node.js 20 or newer (`node -v`), npm and git
- A Garmin Connect account with some activities, and a **Personal API key** (below)
- Optional: [Claude Code](https://claude.com/claude-code) or Claude Desktop. Developed and used on macOS; CI runs on Linux; Windows is untested.

## Quick start

### 1. Get a Personal API key

On Garmin Connect (web): **Profile & Account → Settings → Personal API Key**, then create a key. It is shown **once**, so copy it now. It expires after the 30 days to 1 year you choose, and you can revoke it there at any time.

### 2. Install

```bash
git clone https://github.com/ndedic/garmin-kit.git
cd garmin-kit
npm ci
npm run build
```

### 3. Add your key

```bash
cp .env.example .env
chmod 600 .env
```

Open `.env` and replace `your-key-here` with your key. `.env` is git-ignored. It must be in the repo root (next to `package.json`): garmin-kit deliberately ignores a `.env` in whatever directory you run it from, and reads nothing from it except `GARMIN_PERSONAL_API_KEY`. A real `GARMIN_PERSONAL_API_KEY` environment variable takes precedence over the file.

### 4. Check that it works

```bash
node packages/cli/dist/cli.js analyse
```

You should see a JSON summary of your latest run (see [`garmin analyse`](#garmin-analyse) for what's in it). If you see an error instead, jump to [Troubleshooting](#troubleshooting).

### 5. Connect Claude

Pick one or both. You only need to do each once.

**Claude Code, MCP server** (works from any directory):

```bash
claude mcp add --scope user garmin -- node "$PWD/packages/mcp/dist/index.js"
```

**Claude Code, skill** (lighter than MCP: nothing is loaded until you ask a running question). The skill calls the `garmin` command, so put it on your `PATH` first:

```bash
(cd packages/cli && npm link)
```

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD/skills/garmin" ~/.claude/skills/garmin
```

The symlink means a later `git pull` updates the skill too. Use `cp -R` instead if you want a frozen copy.

**Claude Desktop** (MCP only): add this to `claude_desktop_config.json`, with the absolute path to your clone. No `env` block is needed because the server reads the key from the repo's `.env`:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-kit/packages/mcp/dist/index.js"]
    }
  }
}
```

### 6. Try it in a new Claude session

Skills and MCP servers load when a session starts, so **open a new Claude Code session** (any directory). In Claude Code, run `/mcp` to confirm `garmin` shows as connected, then ask:

- "analyse my last run"
- "how does it compare to my previous runs?"
- "how did I sleep last night?"
- "has my HRV been going down this week?"

For the first question Claude calls `analyse_run` (MCP) or `garmin analyse` (skill) and replies with a verdict plus the evidence: pacing, heart-rate drift, how it compares with your recent runs, and how rested you were. It should never ask you for a path or a key.

If you installed both the skill and the MCP server, Claude may use either; they return the same data. Keep only the one you prefer if you want it predictable.

## Commands

```bash
garmin analyse                 # compact summary of your latest run
garmin analyse 123456789       # ...or a specific activity
garmin last-run                # raw JSON for the latest run
garmin runs --limit 3          # raw list of recent runs (--limit 1-100, default 5)
garmin runs --date 2026-10-20
garmin activity 123456789      # raw activity detail
garmin laps 123456789          # laps, parsed from the FIT export
garmin records 123456789 [--every-seconds N]   # per-second samples (large: use --every-seconds)
garmin download 123456789 [--format fit|zip|json] [--output FILE]   # writes a file; see Security notes

# wellness (a date defaults to today; ranges default to the last 7 days, max 90)
garmin sleep [--date YYYY-MM-DD]
garmin sleep-summaries [--start-date D] [--end-date D]
garmin hrv [--date D]
garmin hrv-summaries [--start-date D] [--end-date D]
garmin body-battery [--start-date D] [--end-date D]
garmin heart-rate [--date D]            # includes resting heart rate
garmin daily-summaries [--start-date D] [--end-date D]
```

`garmin --help` prints this list, generated from the same definitions. Activity IDs come from `runs` or `last-run`. Results are JSON. Anything over 200,000 characters is refused with a hint to narrow the request (override on the CLI with `--no-limit`). Commands other than `analyse` print raw Garmin JSON, which can include your name and GPS coordinates.

The CLI is also what the skill runs. In the examples above, `garmin` assumes you ran `npm link` (step 5); without it, use `node packages/cli/dist/cli.js` instead.

### `garmin analyse`

About 90 lines of JSON designed for people and for LLMs (example values):

```json
{
  "date_local": "2026-10-25 09:01:10",
  "distance_km": 5.6, "duration_min": 31.8, "avg_pace_min_per_km": "5:40",
  "avg_hr": 176.2, "max_hr": 193, "avg_cadence_spm": 162.3,
  "splits": [ { "split": 1, "distance_m": 1000, "pace_min_per_km": "5:57", "avg_hr": 153, "cadence_spm": 158 } ],
  "first_half":  { "pace_min_per_km": "5:50", "avg_hr": 167.7 },
  "second_half": { "pace_min_per_km": "5:31", "avg_hr": 185.2 },
  "pacing": "negative split", "hr_drift_bpm": 17.5,
  "recovery": { "sleep_hours": 6.7, "sleep_score": 65, "hrv_last_night_ms": 41, "hrv_vs_baseline": "within",
                "resting_hr_bpm": 57, "body_battery_at_run_start": 84, "body_battery_run_impact": -17 },
  "previous_runs": [ { "date": "2026-10-08", "distance_km": 6.24, "pace_min_per_km": "7:11", "avg_hr": 156 } ],
  "vs_previous": { "pace_delta_s_per_km": -93, "avg_hr_delta_bpm": 20.9 }
}
```

- **Totals, splits and pacing:** distance, duration, pace, HR, cadence in steps per minute, per-km splits, first half against second half, and HR drift.
- **`previous_runs` and `vs_previous`:** your 3 runs before this one, and how this run compares. A negative pace delta means faster.
- **`recovery`:** how rested you were going into the run. It is best effort: anything Garmin has no data for that day is left out, and data from other days is never substituted.
- Units are in the field names. Name, GPS coordinates and profile images are deliberately left out.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Set GARMIN_PERSONAL_API_KEY in the repo's .env file or the environment.` | No key found. `.env` must be in the repo root (next to `package.json`), not in your current directory. Check with `ls -a` there. |
| `HTTP 401` | Key rejected, expired or revoked. Create a new one (step 1) and update `.env`. A cached token is refreshed automatically; `rm ~/.config/garmin/connect-personal-api-bearer-token.json` forces a fresh exchange. |
| `HTTP 429` | Rate limited. Wait a minute; the CLI already retries twice. |
| Warning: `.env is readable by other users` | Run `chmod 600 .env`. |
| `garmin: command not found` | Run `(cd packages/cli && npm link)` from the repo root, and make sure your npm global bin directory is on `PATH` (`npm prefix -g`, then `/bin`). A root-level `npm link` does not provide the command. |
| `claude mcp list` shows `garmin` failed, or it is missing | Re-run `npm run build` (the server runs the compiled `dist/`). The path in `claude mcp add` must be absolute. Remove and re-add with `claude mcp remove garmin --scope user`. To see the real error, run `node packages/mcp/dist/index.js`: it should print `garmin-kit MCP server running on stdio` and wait. |
| Claude doesn't use the skill or the tools | Start a **new** session. Check `ls ~/.claude/skills/garmin/SKILL.md` and `/mcp`. You can also ask outright: "use the garmin skill to analyse my last run". |
| `Output is N characters (limit 200000)` | A raw command returned too much. Use `analyse`, or add `--every-seconds 60` to `records`. |
| `runs` prints `[]`, or `recovery` is missing parts | Garmin has no matching activity or wellness data for that range or day (for example today's sleep before your watch syncs). |
| `Unexpected Garmin response for …` | Garmin changed a payload shape. Please open an issue with the message. |
| Node errors on start | Check `node -v` is 20 or newer. |

## Uninstall

```bash
claude mcp remove garmin --scope user
rm -f ~/.claude/skills/garmin
(cd packages/cli && npm unlink -g @garmin-kit/cli)
rm -f ~/.config/garmin/connect-personal-api-bearer-token.json
```

Then delete the clone, and revoke the key on Garmin Connect (Profile & Account → Settings → Personal API Key). The token file is shared with Garmin's own client, so only remove it if you don't use that.

## How it works

```
packages/
  core/   @garmin-kit/core   Garmin client, token cache, FIT parsing, run analysis, and the tool registry
  cli/    @garmin-kit/cli    `garmin` command, generated from the registry
  mcp/    @garmin-kit/mcp    MCP server (stdio), generated from the same registry
skills/garmin/               Claude Code skill; its command list is generated from the registry
scripts/gen-skill.ts         regenerates the skill's command list
```

**Tools live in core.** `packages/core/src/tools.ts` has two layers:

1. **Orthogonal primitives:** plain async Node functions that each do one job and know nothing about any interface: `listRuns`, `getActivity`, `getLaps`, `getRecords`, `downloadActivity` and the wellness readers (`getSleepSummaries`, `getHrvSummaries`, `getBodyBattery`, `getHeartRate`, ...). `analyseRun` only composes them with the pure `analyse()` function.
2. **Tool definitions:** plain data (name, description, a strict [zod](https://zod.dev) input schema, `surfaces`, and `access: "read" | "write"`) plus a thin adapter to the function above.

The CLI, the MCP server and the skill are all derived from the definitions, so a new tool is written once:

| Surface | How it's derived |
|---|---|
| CLI | command, flags, argument coercion, validation and `--help` from the zod `input` (`packages/cli`) |
| MCP | every `access: "read"` tool with `"mcp"` in `surfaces`; the `inputSchema` is the zod schema converted to JSON Schema (`packages/mcp`) |
| Skill | `npm run gen:skill` rewrites the command list in `skills/garmin/SKILL.md`; `npm run check:skill` fails if it is stale. Only `read` tools are listed, so the model never offers to write files |

To add a tool: write the function, add a `defineTool({...})` entry to `tools` with an `access` value, then run `npm run build && npm run gen:skill`. The CLI command, the MCP tool and the skill entry appear automatically.

## Development

```bash
npm run build        # tsc -b across packages
npm test             # skill-drift check + node:test via tsx (includes MCP server tests over an in-memory transport)
npm run smoke:mcp    # live check: starts the built MCP server over stdio and calls the real API
npm run audit:deps   # npm audit for production dependencies
npm run gen:skill    # refresh the skill's command list
npm run check:skill  # fails if it is stale (also part of npm test)
```

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`, build, tests and the dependency audit on Node 20 and 22.

## Security notes

- **Token cache.** The 24-hour access token is cached in `~/.config/garmin/connect-personal-api-bearer-token.json` (directory `0700`, file `0600`; the path follows `$HOME`), the same location and format as Garmin's own [`garmin-personal-api`](https://github.com/garmin/connect-personal-api-python) client, so both share it. It is reused while more than an hour remains and refreshed automatically after a 401. The token is always written to a brand-new `0600` temp file that is renamed over the cache, so it is never written into a file that already existed (whatever its permissions, and whoever already has it open). A cache that is a symlink, owned by someone else, or readable by other users is ignored and replaced; a symlink is never followed. The cache is tied to your key by an unsalted SHA-256 fingerprint of the base URL and key (the key itself is never stored). That is Garmin's format, and it is what makes sharing possible; it means anyone who can already read the cache could test guesses of your key, but they would be holding a working token anyway. Delete the file to force a new exchange; revoking your key on Garmin Connect invalidates it.
- **Environment.** Only `GARMIN_PERSONAL_API_KEY` is read from a `.env` file, and only from the repo's own. Other variables in it, and any `.env` in the current directory, are ignored. If the key is loaded from a `.env` that other users can read, a warning is printed to stderr (advisory only; nothing is printed when the key comes from the real environment, and on Windows no check is made). Prefer the `.env` file over putting the key on a command line (`claude mcp add -e KEY=...` lands in your shell history and process list) or in a plaintext client config.
- **Tool exposure.** Every tool declares `access: "read"` or `"write"`. Only `read` tools are exposed over MCP or listed in the skill, so a new tool that forgets to say is never exposed. All MCP tools carry `readOnlyHint`, but note that any call may create or refresh the token cache file above; a client that auto-approves "read-only" tools is approving that credential write.
- **CI and supply chain.** GitHub Actions are pinned to commit SHAs, CI runs `npm ci --ignore-scripts` with a read-only token and no secrets, and has a timeout and concurrency limit. `.github/CODEOWNERS` marks CI, the skill and the credential-handling code; enforcing review of them requires enabling branch protection with "Require review from Code Owners" in the repository settings (not set by the code).
- **Network.** The only peer is `https://personal.connectapi.garmin.com`. Redirects are never followed, and a request path that could change the host (`//host`, `@host`, an absolute URL) is refused before anything is sent, so the key and token cannot go elsewhere.
- **Inputs and responses.** Every tool input is validated by a strict zod schema (unknown options are rejected, no type coercion over MCP), and the Garmin payloads we compute on are validated too, so API changes fail with a clear message. Response bodies are capped at 64 MiB, decompressed FIT files at 100 MiB (and ZIPs at 64 entries), and output shown to a model at 200,000 characters. Error text is stripped of control characters, and in results the characters JSON does not escape (DEL, C1 such as U+009B, line separators) are escaped as `\uXXXX`, so provider text cannot smuggle terminal escape sequences; the data itself is unchanged.
- **Files.** `download` is the only command that writes files. It is CLI-only, is not offered by the skill or MCP server, refuses to overwrite, creates files `0600`, and accepts only relative `--output` paths without `..`, drive letters or reserved device names, checked again inside the download function and resolved through symlinks so the file must land inside the current directory. Files named `activity-*` and `*.fit` are git-ignored; a different `--output` name inside a git repository is not, so keep health and GPS data out of tracked paths. File permissions (`0600`/`0700`) are a POSIX guarantee; on Windows they rely on the permissions of the containing folder.

## Privacy

Personal-API data includes health metrics and GPS tracks, and sleep, HRV, heart rate and Body Battery are health data too. Keep `.env` private, and be careful where you paste raw `activity`, `laps`, `records` or wellness output. `analyse` leaves out your name, GPS coordinates and profile images; when you use Claude, the results you ask for are sent to Anthropic as part of the conversation, like anything else you ask it about.
