# subplug

An opencode plugin (server + TUI) that lets a session watch the other sessions
and subagents working in a project, overlaid with the `coordination/` claim
registry. Viewing is read-only. An opt-out, queue-only comms tier can send
addressed messages between sessions: no abort, no steer, no broadcast.

Compatible with opencode `1.18.x` (`@opencode-ai/plugin` `^1.18.32`, lockfile
tested against `1.18.33`). The TUI renderer packages (`@opentui/*`,
`solid-js`) are declared as optional peer dependencies, so the host's copies
are used and no duplicate Solid instance is installed.

Requirements: [Bun](https://bun.sh) `>= 1.3` (for local dev) and
opencode `1.18.x`.

## Install

opencode discovers both entrypoints from `package.json` `exports["./server"]`
and `exports["./tui"]`, so one spec installs the server and TUI plugins
together. The `opencode plugin` command patches both config files for you.

### From npm

```sh
cd /path/to/your/project
opencode plugin subplug
```

```
◇  Detected server + tui targets
●  Added to <project>/.opencode/opencode.json
●  Added to <project>/.opencode/tui.json
```

Restart opencode afterwards. Add `--global` to install into the global config
instead of the project, or `--force` to replace an existing entry.

### From a local clone (development)

```sh
git clone https://github.com/tfisatypedef/subplug.git ~/src/subplug
cd ~/src/subplug && bun install          # runtime + test deps
cd /path/to/your/project
opencode plugin ~/src/subplug            # absolute path to the clone
```

### Manual config

`opencode plugin` just writes these entries, so you can also add them yourself.
Path specs resolve relative to the config file's directory (`.opencode/`), not
the project root, so absolute paths are unambiguous:

`.opencode/opencode.json` (server):

```json
{
  "plugin": [
    ["/path/to/subplug"]
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

- Update (npm): `opencode plugin --force subplug`, then restart opencode. The
  config entry is unchanged when the version moves.
- Update (clone): `cd /path/to/subplug && git pull && bun install`, then
  restart opencode (re-run `opencode plugin --force <spec>` if options changed).
- Remove: delete the `plugin` entry from `.opencode/opencode.json` and
  `.opencode/tui.json` (or the global equivalents).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `coord.injectIdentity` | always on | Accepted for compatibility. In coordination-enabled repos the server always sets `COORD_AGENT_ID` via `shell.env`: every session gets a distinct `<name>@<host>/<full session id>`, overriding inherited or already populated values (the base is cached per repository). |
| `comms.inject` | `true` | Append pending inbox notices as one synthetic part on the recipient's next turn (strict no-op when the inbox is empty); `false` disables. |
| `storageDir` | opencode state dir | Override the hub root (also `SUBPLUG_STORAGE_DIR`). |
| `hubGroup` | project id | Override the hub key so multiple clones/windows can share one hub (combine with a shared `storageDir`; also `SUBPLUG_HUB_GROUP`). Sanitized for the filesystem; degenerate values (`.`, `..`, empty) fall back to `unknown`. |
| `retentionBytes` | 4 MiB | Rotate `events.<server>.jsonl` at this size (one `.1` segment kept). |
| `maxAgeMs` | 24 h | Ignore records older than this when folding. |
| `intervalMs` (TUI) | 1000 | Hub poll interval. |
| `sidebarAspect` (TUI) | 0.5 | Fallback cell width/height ratio for the Agents panel when the terminal doesn't report pixel resolution (rows = `round(36 × aspect)`, clamped 11–24). |
| `route` / `command` (TUI) | `subplug` / `subplug.open` | Dashboard route name and palette command. |

## What gets recorded

Metadata only. Session lifecycle (created/updated/deleted/status/idle/error),
agent and model per session, the injected `session.identity`, running cost
snapshots, todo counts, and bash command summaries that are categorized
(`git-commit`, `git-push`, `coord`, `plant`, `test`) and redacted for tokens,
secrets, and URL credentials. No message bodies, no file contents.

Inter-session comms are metadata pointers only: `comms.sent`/`delivered`/`seen`
carry `from`, `to`, `msgID`, `kind`, `delivery`, and a redacted summary. Message
bodies live in the native session store and are never written to the hub. Each
server remembers byte offsets per hub file and reads only new bytes before
injecting, so pointers written by another clone or window after this server
started are still delivered on the next turn; re-reads are idempotent (deduped
by `msgID`).

At startup the server imports the project's existing sessions (metadata only,
bounded by `maxAgeMs`) so restored sessions appear before they emit new events.
It starts with the 50 most recent sessions and walks their native children,
up to 200 sessions total, including nested subagents omitted from the initial
list. Native `task` tool updates also recover parent/child links, agent type,
and model while work is running; task prompt bodies stay out of the hub.

In coordination-enabled repos, a `git commit`/`git push`/`coord` command whose
staged paths are not covered by the session's claims is recorded as a
`command.risk` event (read-only check; nothing is ever blocked) and surfaced as
a TUI toast.

In coordination-enabled repos with `tools/coord.py`, `edit`, `write`, and
`apply_patch` calls auto-acquire (or refresh) an exact-path edit lease for the
calling session before the tool runs; a path leased by another session denies
the call with the lease message. `apply_patch` checks every add/update/delete
path plus both sides of a move. The denial is thrown from `tool.execute.before`,
not swallowed by the monitoring catch. Shell commands that mutate files are not
gated, and leases live in the per-worktree git directory, never in git.

Hub layout: `<stateDir>/subplug/<hubKey>/events.<serverID>.jsonl` plus a folded
`snapshot.json`, where `<hubKey>` is the project id unless `hubGroup` is set.
Multiple servers append to separate files and every reader folds all of them,
so several opencode windows on the same project aggregate automatically. To
aggregate different clones, point them at the same `storageDir` and set the same
`hubGroup`.

The server plugin also registers a `swarm_status` tool that returns the session
tree plus active claims, conflicts, and the last passing verification. `format`
accepts `text` (default), `json`, or `tree`; the tree format nests children
under parents, marks orphans/deleted sessions, and prints a per-root subtree
rollup (sessions, busy/retry/error, cost). Pass `session` (full id or unique
prefix) for one session's detail, and `messages` (count) to include recent
message excerpts. Pass `inbox: true` to pull queued pointers addressed to the
calling session (marks them seen). Message excerpts are read live and are never
written to the hub.

A companion `swarm_send` tool sends follow-up context to another agent or
subagent (`session` or `task_id`): idle targets resume a turn, running targets
require `confirm: true` and are consumed at the next step boundary. The message
stays in the target's native session; the hub gets a metadata-only
pointer. When a recipient starts its next turn, pending pointers are appended as
one synthetic part framed as untrusted data (`comms.inject`, default on).
Idle sends use `session.promptAsync` so sending returns without waiting for
the recipient's response. Both the tool and TUI check current runtime status
before sending and record a redacted inbox pointer only after the API accepts
the request.

## TUI

- Sidebar slot **Agents** (order 650, below the internal blocks): a visually
  square panel — 36 cells wide, height derived from the terminal's cell aspect
  (pixel resolution when the terminal reports it, otherwise `sidebarAspect`)
  and clamped to 11–24 rows — themed with the active opencode theme, listing
  the last 5 sessions with single-line truncated titles, status marks, the
  current session marker, and the active-claim count. Clicking it opens the
  command center.
- Dashboard route `subplug` — a codex-style **command center**: status filter
  tabs (`All / Needs you / Working / Ready / Inactive` with counts), grouping by
  Project / Status / Agent / Hierarchy (default Project; Hierarchy keeps the
  nested parent/child tree and its collapse state in the TUI KV store), and rows
  with a selection caret, status dot, title, status column, and age. A right-hand
  details pane (terminals ≥ 90 columns) shows the selected session's id,
  directory, agent, model, identity, subtree rollup, joined claims (`⇄` plus
  session id, with conflicting claims and their reasons in red), pending
  inbox, last command, and a short transcript preview. The header summarizes
  active claims and conflicts; click tabs to filter or rows to select the
  highlighted session. Open with the `/subplug`
  command or `ctrl+alt+a`. `↑`/`↓` selects, `pgup`/`pgdn` page, `home`/`end`
  jump, `tab`/`shift+tab` cycles the filter, `g` cycles grouping, `/` opens a
  search prompt whose confirmed query filters the list by title, id, agent,
  or directory. `?`/`h` toggles help, and `←`/`→`/space collapse/expand only in
  Hierarchy. Enter opens the selected session: it switches opencode when the
  host knows the session, including empty sessions omitted from the sync store;
  a host-client 404 opens the in-plugin `subplug.session` detail. Lookup failures
  show an error toast. `esc`/`q` first closes help or clears an active search,
  then returns to the view you came from.
- Detail route `subplug.session`: breadcrumb, metadata, subtree rollup, todos,
  selectable subagents (Enter descends; `esc` pops back), joined claims, a
  pending **Inbox** panel, and a store-backed live transcript with full parts:
  text, folded reasoning, tool calls with status/title/elapsed/output tail, and
  file/patch rows. `pgup`/`pgdn` scroll the transcript; usage shows context
  from the max assistant input plus summed cost. Transcripts are read from the
  TUI session store when present, falling back to the live SDK, and are never
  written to the hub.
- `f` (or `m`) and the clickable **[f] Follow up** action compose context for
  the selected agent/subagent (dashboard) or the viewed session (detail).
  Running targets ask for confirmation after you enter the context; idle
  targets resume. TUI sends appear in the same inbox metadata as tool sends.
- Toasts plus attention sounds on `session.error`, subagent completion, and
  uncovered-commit risk.

### Interacting

The sidebar **Agents** block is display-only apart from click-to-open: clicking
it (or pressing `ctrl+alt+a`, or typing `/subplug`) opens the dashboard.

- Dashboard: `↑`/`↓` select, `pgup`/`pgdn` page, `home`/`end` jump,
  `tab`/`shift+tab` filter, `g` grouping, `/` search, `?` help, `←`/`→`
  collapse/expand (Hierarchy), `Enter` opens the session (switches to it, or the
  detail view when it is not local), `f`/`m` follow-up, `Esc`/`q` closes.
- Session detail: `↑`/`↓` select a subagent, `Enter` descends into it,
  `pgup`/`pgdn` scroll the conversation, `f`/`m` follows up with the viewed session, `Esc`/`q`
  goes back.
- Follow-ups resume an idle target; running targets ask for confirmation and
  are queued for their next step boundary. Agents can also call `swarm_send`
  directly.

While the composer or confirmation is open, `Esc` cancels that dialog and
keeps the agent view open. Press `Esc` again to go back from the view.

For example, open `/subplug`, select a parent agent or descend into one of its
subagents, then press `f` and enter: “Use the updated fixture; keep the public
API unchanged.” The target receives that text in its own conversation.
You can also ask your current agent: “Find the test subagent with `swarm_status`
and send it this follow-up with `swarm_send`.”

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
- `/subplug` opens the command center: filter tabs with counts, `g` cycles
  grouping (Project → Status → Agent → Hierarchy; Hierarchy nests the subagent
  under its parent with collapse via `←`/`→`), a per-selection details pane with
  subtree rollup, joined claims (`⇄ <session>`), and conflict coloring;
- Enter opens the detail view for a session this instance does not own (as in
  the demo): breadcrumb, rolled-up subtree cost/counts, a pending **Inbox**
  (seeded by `--demo`), and a live transcript (tool status/title/output tail)
  that updates while the demo subagent runs; `m`
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

Expected: the root identity is `Harness Agent@<host>/<rootID>`; the child shows
`parent=<root id>`, `kind=subagent`, and identity
`Harness Agent@<host>/<childID>`; claims list `⇄ <session>` when the
session identity matches a claim's agent.
