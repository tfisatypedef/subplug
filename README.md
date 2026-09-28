# subplug

An opencode plugin (server + TUI) that lets a session watch the other sessions
and subagents working in a project, overlaid with the `coordination/` claim
registry. Read-only: no abort, steer, or gating.

Compatible with opencode `1.18.32` (`@opencode-ai/plugin` pinned).

Requirements: [Bun](https://bun.sh) `>= 1.3` (for install/dev) and
opencode `1.18.x`.

## Install

opencode discovers both entrypoints from `package.json` `exports["./server"]`
and `exports["./tui"]`, so one spec installs the server and TUI plugins
together. The `opencode plugin` command patches both config files for you.

### From a clone (GitHub download)

```sh
git clone https://github.com/tfisatypedef/subplug.git ~/src/subplug
cd ~/src/subplug && bun install          # runtime deps for both entrypoints
cd /path/to/your/project
opencode plugin ~/src/subplug            # absolute path to the clone
```

```
◇  Detected server + tui targets
●  Added to <project>/.opencode/opencode.json
●  Added to <project>/.opencode/tui.json
```

Restart opencode afterwards. Add `--global` to install into the global config
instead of the project, or `--force` to replace an existing entry.

### From npm (once published)

```sh
opencode plugin subplug
```

### Manual config

`opencode plugin` just writes these entries, so you can also add them yourself.
Path specs resolve relative to the config file's directory (`.opencode/`), not
the project root, so absolute paths are unambiguous:

`.opencode/opencode.json` (server):

```json
{
  "plugin": [
    ["/path/to/subplug", { "coord": { "injectIdentity": false } }]
  ]
}
```

`.opencode/tui.json` (TUI):

```json
{
  "plugin": [["/path/to/subplug", { "enabled": true, "storageDir": null }]]
}
```

Path plugins must default-export an object with `id` plus either `server` or
`tui`; the two entries cannot live in one module.

### Update / remove

- Update: `cd /path/to/subplug && git pull && bun install`, then restart
  opencode (re-run `opencode plugin --force <spec>` if options changed).
- Remove: delete the `plugin` entry from `.opencode/opencode.json` and
  `.opencode/tui.json` (or the global equivalents).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `coord.injectIdentity` | `false` | Set `COORD_AGENT_ID` via `shell.env` for coordination-enabled repos: roots share `<name>@<host>`; subagents get a unique `<name>@<host>/<sessionID8>`. |
| `storageDir` | opencode state dir | Override the hub root (also `SUBPLUG_STORAGE_DIR`). |
| `retentionBytes` | 4 MiB | Rotate `events.<server>.jsonl` at this size (one `.1` segment kept). |
| `maxAgeMs` | 24 h | Ignore records older than this when folding. |
| `intervalMs` (TUI) | 1000 | Hub poll interval. |
| `route` / `command` (TUI) | `subplug` / `subplug.open` | Dashboard route name and palette command. |

## What gets recorded

Metadata only. Session lifecycle (created/updated/deleted/status/idle/error),
agent and model per session, the injected `session.identity`, todo counts, and
bash command summaries that are categorized (`git-commit`, `git-push`, `coord`,
`plant`, `test`) and redacted for tokens, secrets, and URL credentials. No
message bodies, no file contents.

At startup the server imports the project's existing sessions (metadata only,
bounded by `maxAgeMs`) so restored sessions appear before they emit new events.

When identity injection is on, a `git commit`/`git push`/`coord` command whose
staged paths are not covered by the session's claims is recorded as a
`command.risk` event (read-only check; nothing is ever blocked) and surfaced as
a TUI toast.

Hub layout: `<stateDir>/subplug/<projectID>/events.<serverID>.jsonl` plus a
folded `snapshot.json`. Multiple servers append to separate files; readers fold
all of them, so other windows/clones can be aggregated later.

The server plugin also registers a read-only `swarm_status` tool that returns
the session tree plus active claims, conflicts, and the last passing
verification (text or JSON). Pass `session` (full id or unique prefix) for one
session's detail, and `messages` (count) to include recent message excerpts.
Message excerpts are read live and are never written to the hub.

## TUI

- Sidebar slot **Agents** (order 650, below the internal blocks): the last 8
  sessions, status marks, the current session marker, and the active-claim
  count.
- Dashboard route `subplug`: all sessions with status/agent/model/age and the
  claim list with expiry, batons, conflicts, and the session each claim is
  joined to (`⇄ <session>`). Open with the `/subplug` command or `ctrl+alt+a`.
  Arrow keys select a session; Enter opens the detail view; `esc`/`q` returns to
  the view you came from.
- Detail route `subplug.session`: metadata, todos, subagents, joined claims,
  token/context usage (from the last assistant message and the provider model
  limit), and the last messages with tool calls. `esc`/`q` returns to the
  dashboard. Conversation is fetched live over the SDK and never stored in the
  hub.
- Toasts plus attention sounds on `session.error`, subagent completion, and
  uncovered-commit risk.

## Development

```sh
bun install
bun run typecheck
bun test
bun run scripts/dev-harness.ts                 # headless server spike (scratch config + repo)
bun run scripts/dev-harness.ts --tui           # headless TUI load check (marker file)
bun run scripts/dev-harness.ts --probe-comms   # busy-session admission + v1/v2 store split
bun run scripts/dev-harness.ts --probe-tui-state  # plugin store coverage for subagents
```

Each harness run uses a random port and an isolated XDG state under
`.harness/xdg`, so it does not touch your real opencode state. `--keep` leaves
the scratch dir behind; `SUBPLUG_SKIP_BASELINE=1` skips the baseline import for
quiet probes (see PLAN.md "P4/P5 design").

The harness seeds a `coordination/claims` registry, starts a throwaway
`opencode serve` under a scratch `OPENCODE_CONFIG_DIR`, creates a root and a
child session, probes `COORD_AGENT_ID` through `session.shell`, and checks the
session tree, identity suffixes, and `swarm_status` registration.

## Manual verification

### Visual TUI check

```sh
bun run scripts/dev-harness.ts --demo --keep
# POSIX:
export OPENCODE_CONFIG_DIR="$PWD/.harness/config"; opencode .harness/repo
# PowerShell:
$env:OPENCODE_CONFIG_DIR="$PWD/.harness/config"; opencode .harness/repo
```

`--demo` seeds a root session (busy), a subagent (idle), a joined claim, a
conflict, and a stale risk. In the TUI:

- the sidebar **Agents** slot (bottom) lists both sessions and the active-claim
  count;
- `/subplug` opens the dashboard: sessions with status/agent/model/age, the
  subagent nested under its parent, claims with `⇄ <session>` for the joined
  holder, and conflict coloring;
- in a second terminal run `bun run scripts/dev-harness.ts --poke-risk` to
  append a live risk and confirm the warning toast + attention sound.

### Real `task` subagent check

With the TUI (or `opencode` in general) open in `.harness/repo`, prompt:

> Spawn exactly one subagent with the task tool. Ask it to run
> `node -p "process.env.COORD_AGENT_ID"` and report the output.

Then inspect the hub without leaving the repo:

```sh
bun run scripts/dev-harness.ts --inspect
```

Expected: the root session keeps `Harness Agent@<host>`; the child shows
`parent=<root id>`, `kind=subagent`, and identity
`Harness Agent@<host>/<childID[0:8]>`; claims list `⇄ <session>` when the
session identity matches a claim's agent.

