# subplug

An opencode v2 plugin (server + TUI) that lets a session watch the other
sessions and subagents working in a project, overlaid with the `coordination/`
claim registry. Viewing is read-only. An opt-out comms tier can send addressed
messages between sessions with explicit delivery semantics (idle targets get a
`steer`, running targets queue behind a confirmation): no abort, no broadcast.

Compatible with opencode `2.x` (`@opencode/plugin` `^2.0.19`). Nightly
`0.0.0-dev-*` builds are accepted by the canary. The TUI renderer packages
(`@opentui/*`, `solid-js`) are declared as optional peer dependencies, so the
host's copies are used and no duplicate Solid instance is installed.

Requirements: [Bun](https://bun.sh) `>= 1.3` (for local dev) and opencode v2
(the `opencode2` binary from `@opencode/cli`).

## Install

opencode discovers both entrypoints from `package.json` `exports["./server"]`
and `exports["./tui"]`, or from `server.ts` / `tui.tsx` when the package is a
local directory. One spec installs the server and TUI plugins together.

### From npm

```sh
opencode plugin add subplug
```

The CLI installs the package into the global config. Restart opencode
afterwards. (The in-TUI plugin manager under `/plugins` can install, update,
and list plugins instead.)

### From a local clone (development)

```sh
git clone https://github.com/tfisatypedef/subplug.git ~/src/subplug
cd ~/src/subplug && bun install          # runtime + test deps
```

Then add the clone as a local plugin directory. Local specs must be
directories; the host loads `server.ts` and `tui.tsx` from the root:

`opencode.json` (server):

```json
{
  "plugins": [{ "package": "/home/you/src/subplug", "options": { "storageDir": "/tmp/subplug-hub" } }]
}
```

`cli.json` in the same config directory (TUI; options do not propagate from
`opencode.json`):

```json
{
  "plugins": [{ "package": "/home/you/src/subplug", "options": { "storageDir": "/tmp/subplug-hub" } }]
}
```

### Manual config (published package)

`opencode.json` (server) and `cli.json` (TUI), both in the config directory
(global `OPENCODE_CONFIG_DIR` or a project's `.opencode/`):

```json
{
  "plugins": [
    { "package": "subplug", "options": { "comms": { "inject": true } } },
    { "package": "subplug", "options": { "web": { "enabled": false } } }
  ]
}
```

The server and TUI entries share one module; the host picks the right
entrypoint from the package exports.

### Update / remove

- Update (npm): `opencode plugin update`, then restart opencode.
- Update (clone): `cd /home/you/src/subplug && git pull && bun install`, then
  restart opencode.
- Remove: `opencode plugin remove subplug`, or delete the `plugins` entries
  from `opencode.json` and `cli.json`.

## Options

Server options live in `opencode.json`; TUI options must be set in `cli.json`
(or via `SUBPLUG_STORAGE_DIR`/`SUBPLUG_HUB_GROUP`), because opencode only
passes plugin options to the entrypoint that declared them. When the TUI has no
explicit `storageDir`, it reads the hub pointer the server writes under
`<stateDir>/subplug/hub.json`.

| Option | Default | Meaning |
| --- | --- | --- |
| `coord.injectIdentity` | always on | Accepted for compatibility. In coordination-enabled repos the server prefixes `bash` tool commands with `export COORD_AGENT_ID=...`, so every session gets a distinct `<name>@<host>/<full session id>`; the base is cached per repository. |
| `comms.inject` | `true` | Append pending inbox notices to the recipient's next prompt as one untrusted-data block (strict no-op when the inbox is empty); `false` disables. |
| `storageDir` | opencode state dir | Override the hub root (also `SUBPLUG_STORAGE_DIR`). |
| `hubGroup` | project id | Override the hub key so multiple clones/windows can share one hub (combine with a shared `storageDir`; also `SUBPLUG_HUB_GROUP`). Sanitized for the filesystem; degenerate values (`.`, `..`, empty) fall back to `unknown`. |
| `retentionBytes` | 4 MiB | Rotate `events.<server>.jsonl` at this size (one `.1` segment kept). |
| `maxAgeMs` | 24 h | Ignore records older than this when folding. |
| `web.enabled` (server) | `false` | Serve the read-only web view on `127.0.0.1`. |
| `web.port` (server) | `7690` | Web view port. |
| `web.token` (server) | none | Optional `?token=` gate on every web request. |
| `intervalMs` (TUI) | 1000 | Hub poll interval. |
| `sidebarAspect` (TUI) | 0.5 | Fallback cell width/height ratio for the Agents panel when the terminal doesn't report pixel resolution (rows = `round(36 × aspect)`, clamped 11–24). |
| `remote` (TUI) | `auto` | Detect a remote attach from `client.server.info().urls` versus local interfaces; `remote`/`local` force it (also `SUBPLUG_REMOTE`). On remote the TUI is hub-free: claims/comms unavailable. |
| `route` (TUI) | `subplug` | Dashboard route name. |

The dashboard command is the named keymap command `subplug.open` (default
`ctrl+alt+a`, also `/subplug`); remap it with the host's `keybinds` config.
The v1 `keybinds`/`command`/`enabled` plugin options are gone.

## What gets recorded

Metadata only. Session lifecycle (created/renamed/agent/model/usage/deleted/
status/idle/error), the injected `session.identity`, running cost snapshots,
and bash command summaries that are categorized (`git-commit`, `git-push`,
`coord`, `plant`, `test`) and redacted for tokens, secrets, and URL
credentials. Todo counts and message bodies are never recorded.

Inter-session comms are metadata pointers only: `comms.sent`/`delivered`/`seen`
carry `from`, `to`, `msgID`, `kind`, `delivery`, and a redacted summary. Message
bodies live in the native session store and are never written to the hub. Each
server remembers byte offsets per hub file and reads only new bytes before
injecting, so pointers written by another clone or window after this server
started are still delivered on the next prompt; re-reads are idempotent
(deduped by `msgID`).

The server plugin activates lazily on the first session at its location, so a
session created at that exact moment can miss `session.created`. The TUI
backfills native sessions it can enumerate into the hub, which closes the gap
as soon as a TUI is open. Backfill treats every session id already in the hub —
including one recorded as `session.deleted` — as known, so it never writes a
duplicate and never resurrects a deleted session.

### Recovery contract

The hub is the only durable state; the event stream is live-only. A plugin that
subscribes after an event was published does not receive it (verified on
opencode `2.0.20`, plugin `0.2.0`: a late subscriber got no pre-existing session
events while a live event during the same window arrived), so history is never
replayed. The TUI store is likewise cold at boot for sessions it did not sync.

After a restart with an existing hub, the server plugin re-subscribes and
re-registers its tools, and readers fold the retained JSONL + snapshot, so
server-side tool visibility and folded state (parent links, status, cost)
survive the restart. The v2 server context has no session-listing API, so
sessions created while no subscriber was attached are recovered only through
the TUI backfill described above. Live session state — status, cost, messages —
is always read through `ctx.data`/`ctx.client`; the hub holds only appended
metadata. A remote attach reads and writes no local hub at all.

In coordination-enabled repos, a `git commit`/`git push`/`coord` command whose
staged paths are not covered by the session's claims is recorded as a
`command.risk` event (read-only check; nothing is ever blocked) and surfaced as
a TUI toast.

In coordination-enabled repos with `tools/coord.py`, `edit`, `write`, and
`apply_patch` calls auto-acquire (or refresh) an exact-path edit lease for the
calling session before the tool runs; a path leased by another session denies
the call with the lease message. `apply_patch` checks every add/update/delete
path plus both sides of a move. The denial is thrown from the tool hook, not
swallowed by the monitoring catch. Shell commands that mutate files are not
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
message excerpts read from `session.context`. Pass `inbox: true` to pull queued
pointers addressed to the calling session (marks them seen).

A companion `swarm_send` tool sends follow-up context to another agent or
subagent (`session` or `task_id`): idle targets get `delivery: "steer"` and
resume immediately, running targets require `confirm: true` and are queued for
their next step boundary. The message stays in the target's native session; the
hub gets a metadata-only pointer. When a recipient starts its next prompt,
pending pointers are appended as one untrusted-data block (`comms.inject`,
default on). Both the tool and TUI check the folded status before sending and
record the pointer only after the prompt is admitted.

## TUI

- The plugin claims the `sidebar.content` slot with an **Agents** panel: a
  visually square block — 36 cells wide, height derived from the terminal's cell
  aspect (pixel resolution when the terminal reports it, otherwise
  `sidebarAspect`) and clamped to 11–24 rows — themed with the active opencode
  theme, listing the last 5 sessions with single-line titles that marquee on
  hover when they overflow, status marks, the current session marker, and the
  active-claim count. Clicking it opens the command center.
- Dashboard route `subplug` — a codex-style **command center**: status filter
  tabs (`All / Needs you / Working / Ready / Inactive` with counts), grouping by
  Project / Status / Agent / Hierarchy (default Project; Hierarchy keeps the
  nested parent/child tree), and rows with a selection caret, status dot, title,
  status column, and age. A right-hand details pane (terminals ≥ 90 columns)
  shows the selected session's id, directory, agent, model, identity, subtree
  rollup, joined claims (`⇄` plus session id, with conflicting claims and their
  reasons in red), pending inbox, last command, and a short transcript preview.
  The header summarizes active claims and conflicts; click tabs to filter or
  rows to select the highlighted session. Open with `/subplug` or
  `ctrl+alt+a`. `↑`/`↓` selects, `pgup`/`pgdn` page, `home`/`end` jump,
  `tab`/`shift+tab` cycles the filter, `g` cycles grouping, `/` opens a search
  prompt. `?`/`h` toggles help; `←`/`→`/space collapse/expand in Hierarchy.
  Enter opens the selected session: it switches opencode when the host knows the
  session (including the in-plugin detail route for sessions this server does
  not own); lookup failures show an error toast. `esc`/`q` first closes help or
  clears an active search, then returns to the view you came from.
- Detail route `subplug.session`: breadcrumb, metadata, subtree rollup,
  selectable subagents (Enter descends; `esc` pops back), joined claims, a
  pending **Inbox** panel, and a live transcript from the TUI session store
  (falling back to `session.context`): text, folded reasoning, tool calls with
  status/title/elapsed/output tail, retries, compaction, and step usage.
  `pgup`/`pgdn` scroll the transcript; usage shows context from the max
  assistant input plus summed cost. Transcripts are never written to the hub.
- `f` (or `m`) and the clickable **[f] Follow up** action compose context for
  the selected agent/subagent (dashboard) or the viewed session (detail).
  Running targets ask for confirmation after you enter the context; idle
  targets resume. TUI sends appear in the same inbox metadata as tool sends.
- Toasts plus attention sounds on `session.execution.failed`, subagent
  completion, and uncovered-commit risk.
- Collapsed groups and grouping are persisted through the plugin's own
  `storage.store` (`preferences`), not the removed v1 KV API; dialogs are the
  host's promise-based dialogs.

### Interacting

The sidebar **Agents** block is display-only apart from click-to-open: clicking
it (or pressing `ctrl+alt+a`, or typing `/subplug`) opens the dashboard.

- Dashboard: `↑`/`↓` select, `pgup`/`pgdn` page, `home`/`end` jump,
  `tab`/`shift+tab` filter, `g` grouping, `/` search, `?` help, `←`/`→`
  collapse/expand (Hierarchy), `Enter` opens the session (switches to it, or the
  detail view when it is not local), `f`/`m` follow-up, `Esc`/`q` closes.
- Session detail: `↑`/`↓` select a subagent, `Enter` descends into it,
  `pgup`/`pgdn` scroll the conversation, `f`/`m` follows up with the viewed
  session, `Esc`/`q` goes back.

While the composer or confirmation is open, opencode's dialog owns the
keyboard; `Esc` cancels that dialog and keeps the agent view open. Press `Esc`
again to go back from the view.

For example, open `/subplug`, select a parent agent or descend into one of its
subagents, then press `f` and enter: “Use the updated fixture; keep the public
API unchanged.” The target receives that text in its own conversation. You can
also ask your current agent: “Find the test subagent with `swarm_status` and
send it this follow-up with `swarm_send`.”

## Web view

A read-only command-center page served by the server plugin on localhost. Off
by default; enable it in the server options:

```json
{ "plugins": [{ "package": "subplug", "options": { "web": { "enabled": true, "port": 7690, "token": "optional" } } }] }
```

Open `http://127.0.0.1:7690` (append `?token=...` when a token is set). The
page polls the folded hub once per second and shows sessions grouped by status,
active claims with conflict flags, and a capped transcript for the selected
session read through `session.context`. It binds `127.0.0.1` only, serves GET
only, and never writes; message bodies stay in the native session store, never
in the hub. The server guards the listener for Node-hosted CLIs and reports a
clear error when `Bun.serve` is unavailable.

## Remote attach

Run sessions on one machine and drive the TUI from another (plugin-only; no
core changes). Because v2 executes server-side, attaching already runs
tools/shell/files on the server machine.

On the server machine:

```sh
OPENCODE_PASSWORD=<password> opencode2 serve --hostname 0.0.0.0 --port 4096
```

On the client machine:

```sh
OPENCODE_PASSWORD=<password> opencode2 --server http://<server-ip>:4096
```

subplug detects the attach automatically (the advertised `urls` don't match any
local interface, with the session directory as a fallback) and renders from the
attached server's live `data.session`/`client` state. A remote attach is
**hub-free**: it never reads or writes the local hub, so claims, conflicts, risk
toasts and command history degrade to "claims unavailable on remote" instead of
showing wrong data. Force the mode with the `remote` TUI option
(`auto`/`remote`/`local`) or `SUBPLUG_REMOTE`. LAN only — plain-HTTP Basic auth
is sniffable — and one attached server at a time.

## Development

```sh
bun install
bun run typecheck
bun test
OPENCODE_BIN=/path/to/opencode2 bun run canary               # host is v2 + matching @opencode/plugin
OPENCODE_BIN=/path/to/opencode2 bun run canary --load        # canary plus the headless TUI load harness
bun run scripts/dev-harness.ts                               # headless server spike (scratch config + repo)
bun run scripts/dev-harness.ts --tui                         # headless TUI load check (marker file)
bun run scripts/dev-harness.ts --probe-tui-state             # plugin store + session.context coverage
SUBPLUG_PROBE_MODEL=provider/model bun run scripts/dev-harness.ts \
  --probe-tui-state --attach --probe-execute  # one bounded scratch prompt
SUBPLUG_PROBE_MODEL=provider/model bun run scripts/dev-harness.ts \
  --probe-tui-state --attach --probe-task     # one task-created child, folded parent check
SUBPLUG_HARNESS_DIR=$TMPDIR/subplug-replay bun run scripts/dev-harness.ts \
  --probe-tui-state --probe-replay            # late-subscriber replay + restart durability
SUBPLUG_PROBE_SERVER_URL=http://<server-ip>:4096 OPENCODE_PASSWORD=<password> \
  SUBPLUG_PROBE_MODEL=provider/model bun run scripts/dev-harness.ts \
  --probe-tui-state --existing-server --probe-execute
bun run scripts/dev-harness.ts --demo --keep                 # seed a hub and print TUI launch instructions
```

The harness resolves the host from `OPENCODE_BIN`, then `opencode2`, then
`opencode`, so a v1 `opencode` on `PATH` does not shadow the v2 build. Each run
uses a random port and an isolated XDG tree under
`${SUBPLUG_HARNESS_DIR:-$TMPDIR/subplug-harness}`, so it never touches your real
opencode state. `--keep` leaves the scratch dir behind. The workspace lives
outside the repo on purpose: opencode watches local plugin sources, so state
writes inside the repo would retrigger plugin reloads.

  `--probe-execute` requires `SUBPLUG_PROBE_MODEL=provider/model` and records
  prompt admission, execution events, store status transitions, transcript
  appearance, and cost in a redacted JSON result. `SUBPLUG_PROBE_TIMEOUT_MS`
  bounds the wait (default 90 seconds). `--existing-server` connects to an
  already running server, writes only to a fresh client scratch directory,
  and retains the result path it prints. It creates two named sessions and
  admits one scratch prompt on that server; execution mode also runs the
  selected model. It never seeds server workspace files or stops the server.
  Run that mode on a second device for the V7 LAN acceptance checklist in
  `V7PLAN.md`; the same-machine `--attach` run is an earlier gate.

  `--probe-task` additionally prompts the root to create one real `task`
  subagent, then verifies that the child's `parentID` matches the root and that
  the folded hub node is a `subagent` with a coordination identity. It is
  model-dependent: a run where the model does not call `task` reports
  `outcome: incomplete` rather than failing.

The spike seeds a `coordination/claims` registry, starts a throwaway
`opencode serve` with Basic auth under a scratch config, forces plugin
activation, creates a session through `/api/session`, and checks the hub
pointer, `server.start`/`session.created`/`session.identity` records, and the
active plugin inventory.

### Publishing

`prepublishOnly` runs `typecheck` + `test`, so a broken tree cannot ship.
Before publishing, run `bun run canary --load` against the v2 host, bump
`version` in `package.json`, then `npm publish` (the `files` whitelist ships
`server.ts`, `tui.tsx`, `src`, `README.md`, and `LICENSE`). CI verifies the
tarball in the `pack` job and runs `canary --load` against `@opencode/cli@dev`
in the `canary` job.

## Manual verification

### Visual TUI check

```sh
bun run scripts/dev-harness.ts --demo --keep
# follow the printed launch instructions, e.g.:
export OPENCODE_CONFIG_DIR="$TMPDIR/subplug-harness/config"
opencode2 "$TMPDIR/subplug-harness/repo"
```

`--demo` seeds a root session (busy), a subagent (idle), a joined claim, a
conflict, and a stale risk. In the TUI:

- the sidebar **Agents** slot lists both sessions and the active-claim count;
- `/subplug` opens the command center: filter tabs with counts, `g` cycles
  grouping (Project → Status → Agent → Hierarchy; Hierarchy nests the subagent
  under its parent with collapse via `←`/`→`), a per-selection details pane with
  subtree rollup, joined claims (`⇄ <session>`), and conflict coloring;
- Enter opens the detail view for a session this instance does not own (as in
  the demo): breadcrumb, rolled-up subtree cost/counts, a pending **Inbox**
  (seeded by `--demo`), and a live transcript that updates while the demo
  subagent runs; `m` opens the composer, which confirms first when the target
  is busy;
- in a second terminal run `bun run scripts/dev-harness.ts --poke-risk` to
  append a live risk and confirm the warning toast + attention sound.

### Real `task` subagent check

With the TUI (or `opencode2`) open in the demo repo, prompt:

> Spawn exactly one subagent with the task tool. Ask it to run
> `node -p "process.env.COORD_AGENT_ID"` through its bash tool and report the
> output.

The identity now arrives as the `export COORD_AGENT_ID='...'` prefix on `bash`
tool calls, so the subagent's reported identity should be
`Harness Agent@<host>/<childID>`. Inspect the hub without leaving the repo:

```sh
bun run scripts/dev-harness.ts --inspect --expect-subagent
```

Expected: the root identity is `Harness Agent@<host>/<rootID>`; the child shows
`parent=<root id>`, `kind=subagent`, and identity
`Harness Agent@<host>/<childID>`; claims list `⇄ <session>` when the session
identity matches a claim's agent. `--expect-subagent` prints `PASS` and exits
non-zero when no such subagent was folded, so the live `task` check is
scriptable. (The old quota-spending `--probe-task` mode was removed with the v1
HTTP endpoints.)
