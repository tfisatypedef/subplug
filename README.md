# subplug

An opencode plugin (server + TUI) that lets a session watch the other sessions
and subagents working in a project, overlaid with the `coordination/` claim
registry. Viewing is read-only. An opt-out, queue-only comms tier can send
addressed messages between sessions: no abort, no steer, no broadcast.

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
| `comms.inject` | `true` | Append pending inbox notices as one synthetic part on the recipient's next turn (strict no-op when the inbox is empty); `false` disables. |
| `storageDir` | opencode state dir | Override the hub root (also `SUBPLUG_STORAGE_DIR`). |
| `retentionBytes` | 4 MiB | Rotate `events.<server>.jsonl` at this size (one `.1` segment kept). |
| `maxAgeMs` | 24 h | Ignore records older than this when folding. |
| `intervalMs` (TUI) | 1000 | Hub poll interval. |
| `route` / `command` (TUI) | `subplug` / `subplug.open` | Dashboard route name and palette command. |

## What gets recorded

Metadata only. Session lifecycle (created/updated/deleted/status/idle/error),
agent and model per session, the injected `session.identity`, running cost
snapshots, todo counts, and bash command summaries that are categorized
(`git-commit`, `git-push`, `coord`, `plant`, `test`) and redacted for tokens,
secrets, and URL credentials. No message bodies, no file contents.

Inter-session comms are metadata pointers only: `comms.sent`/`delivered`/`seen`
carry `from`, `to`, `msgID`, `kind`, `delivery`, and a redacted summary. Message
bodies live in the native session store and are never written to the hub.

At startup the server imports the project's existing sessions (metadata only,
bounded by `maxAgeMs`) so restored sessions appear before they emit new events.

When identity injection is on, a `git commit`/`git push`/`coord` command whose
staged paths are not covered by the session's claims is recorded as a
`command.risk` event (read-only check; nothing is ever blocked) and surfaced as
a TUI toast.

Hub layout: `<stateDir>/subplug/<projectID>/events.<serverID>.jsonl` plus a
folded `snapshot.json`. Multiple servers append to separate files; readers fold
all of them, so other windows/clones can be aggregated later.

The server plugin also registers a `swarm_status` tool that returns the session
tree plus active claims, conflicts, and the last passing verification. `format`
accepts `text` (default), `json`, or `tree`; the tree format nests children
under parents, marks orphans/deleted sessions, and prints a per-root subtree
rollup (sessions, busy/retry/error, cost). Pass `session` (full id or unique
prefix) for one session's detail, and `messages` (count) to include recent
message excerpts. Pass `inbox: true` to pull queued pointers addressed to the
calling session (marks them seen). Message excerpts are read live and are never
written to the hub.

A companion `swarm_send` tool queues an addressed message to another session or
subagent (`session` or `task_id`): idle targets start a turn, busy targets
require `confirm: true` and are consumed at the next step boundary. The message
is a durable user message in the target session; the hub gets a metadata-only
pointer. When a recipient starts its next turn, pending pointers are appended as
one synthetic part framed as untrusted data (`comms.inject`, default on).

## TUI

- Sidebar slot **Agents** (order 650, below the internal blocks): the last 8
  sessions, status marks, the current session marker, and the active-claim
  count.
- Dashboard route `subplug`: a nested session tree (parent/child by depth) with
  status/agent/model/age, the last bash command and its age, orphan (`?`) and
  deleted markers, and a per-root subtree rollup (subagent count, busy/error
  counts, cost). Collapse state is kept in the TUI KV store. The claim list
  shows expiry, batons, conflicts, and the session each claim is joined to
  (`⇄ <session>`). Open with the `/subplug` command or `ctrl+alt+a`. `↑`/`↓`
  selects, `←`/`→` collapses/expands, Enter opens the detail view, `esc`/`q`
  returns to the view you came from.
- Detail route `subplug.session`: breadcrumb, metadata, subtree rollup, todos,
  selectable subagents (Enter descends; `esc` pops back), joined claims, a
  pending **Inbox** panel, and a store-backed live transcript with full parts:
  text, folded reasoning, tool calls with status/title/elapsed/output tail, and
  file/patch rows. `pgup`/`pgdn` scroll the transcript; usage shows context
  from the max assistant input plus summed cost. Transcripts are read from the
  TUI session store when present, falling back to the live SDK, and are never
  written to the hub.
- `m` composes a message to the selected session (dashboard) or the current
  session (detail). Busy targets ask for confirmation first; the send is a
  queue-only v1 `session.prompt`.
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
bun run scripts/dev-harness.ts --probe-inject  # synthetic inbox part + comms.delivered
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
- `/subplug` opens the dashboard: the subagent nested under its parent (with
  collapse via `←`/`→`), per-root subtree rollups, claims with `⇄ <session>` for
  the joined holder, and conflict coloring;
- Enter opens the subagent's detail: breadcrumb, rolled-up subtree cost/counts,
  a pending **Inbox** (seeded by `--demo`), and a live transcript (tool
  status/title/output tail) that updates while the demo subagent runs; `m`
  opens the composer, which confirms first when the target is busy;
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

