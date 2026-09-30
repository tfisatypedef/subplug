# subplug

An opencode v2 plugin (server + TUI) that lets a session watch the other
sessions and subagents working in a project, overlaid with the `coordination/`
claim registry. Viewing is read-only. An opt-out comms tier can send addressed
messages between sessions with explicit delivery semantics (idle targets get a
`steer`, running targets queue behind a confirmation): no abort, no broadcast.

Compatible with opencode `2.x` (`@opencode/plugin` `^2.0.19`). Requires opencode
v2 from `@opencode/cli` (installed as `opencode`; `opencode2` is a legacy alias
for the same binary). The TUI renderer packages (`@opentui/*`, `solid-js`) are
optional peer dependencies, so the host's copies are used.

## Install

`subplug` is not on npm yet; until the first release, install from the git spec
(or a clone, see [CONTRIBUTING.md](CONTRIBUTING.md)).

```sh
opencode plugin add subplug                       # from npm (once published)
opencode plugin add github:tfisatypedef/subplug   # git spec
```

Restart opencode afterwards. That is the whole config: the single entry loads
the server and TUI plugins together and the TUI finds the server's hub
automatically, so no `cli.json` entry is needed. The in-TUI plugin manager under
`/plugins` can also install, update, and list plugins.

To set options, add them to the same `opencode.json` entry (see
[Options](#options)):

```json
{
  "plugins": [
    { "package": "subplug", "options": { "comms": { "inject": true } } }
  ]
}
```

To run from a local clone instead of npm/git, see
[CONTRIBUTING.md](CONTRIBUTING.md).

### Update / remove

- Update: `opencode plugin update`, then restart opencode.
- Remove: `opencode plugin remove subplug`, or delete the `plugins` entry from
  `opencode.json`.

## Options

Server options live in `opencode.json`. TUI-only options (`route`,
`intervalMs`, `sidebarAspect`, `remote`) can be set in `cli.json` or through
`SUBPLUG_STORAGE_DIR`/`SUBPLUG_HUB_GROUP`/`SUBPLUG_REMOTE`. When the TUI has no
explicit `storageDir`, it reads the hub pointer the server writes under
`<stateDir>/subplug/hub.json`, and honors it only when it names the TUI's own
project group.

The everyday options are `comms.inject` and `web.enabled`; the rest tune the hub
or the TUI and can usually be left at their defaults.

| Option | Default | Meaning |
| --- | --- | --- |
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

The hub is the only durable state; the event stream is live-only, so history is
never replayed. After a restart the server re-subscribes and re-registers its
tools, and readers fold the retained JSONL + snapshot, so state (parent links,
status, cost) survives. Live session state — status, cost, messages — is always
read through the host; the hub holds appended metadata only, and a remote attach
reads and writes no local hub at all.

In coordination-enabled repos, a `git commit`/`git push`/`coord` command whose
staged paths are not covered by the session's claims is recorded as a
`command.risk` event (read-only; nothing is blocked) and shown as a toast.
`edit`, `write`, and `apply_patch` calls acquire exact-path edit leases before
the tool runs; a path leased by another session denies the call. Hub layout is
`<stateDir>/subplug/<hubKey>/events.<serverID>.jsonl` plus a folded
`snapshot.json`; `<hubKey>` is the project id unless `hubGroup` is set, and
several windows on one project aggregate automatically. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full recovery contract.

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
  Project / Status / Agent / Hierarchy (default Project, which nests each
  subagent under its parent and collapses with `←`/`→`; Hierarchy is the global
  parent/child tree; `b` breaks subagents back out into a flat list), and rows
  with a selection caret, status dot, title, status column, and age. A
  right-hand details pane (terminals ≥ 90 columns)
  shows the selected session's id, directory, agent, model, identity, subtree
  rollup, joined claims (`⇄` plus session id, with conflicting claims and their
  reasons in red), pending inbox, last command, and a short transcript preview.
  The header summarizes active claims and conflicts; click tabs to filter or
  rows to select the highlighted session. Open with `/subplug` or
  `ctrl+alt+a`. `↑`/`↓` selects, `pgup`/`pgdn` page, `home`/`end` jump,
  `tab`/`shift+tab` cycles the filter, `g` cycles grouping, `b` breaks away,
  `/` opens a search
  prompt. `?`/`h` toggles help; `←`/`→`/space collapse/expand in a nested
  project or Hierarchy.
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
OPENCODE_PASSWORD=<password> opencode serve --hostname 0.0.0.0 --port 4096
```

On the client machine (`<server-ip>` is the server's LAN or encrypted-overlay
address; a cross-device run must use one of those, not `127.0.0.1`, and the
server's firewall must allow inbound TCP 4096):

```sh
OPENCODE_PASSWORD=<password> opencode --server http://<server-ip>:4096
```

subplug detects the attach automatically and renders from the attached server's
live `data.session`/`client` state. A remote attach is **hub-free**: it never
reads or writes the local hub, so claims, conflicts, risk toasts and command
history report "claims unavailable on remote" instead of showing wrong data.
Force the mode with the `remote` TUI option (`auto`/`remote`/`local`) or
`SUBPLUG_REMOTE`. Plain-HTTP Basic auth is sniffable on a shared network, so use
a trusted LAN or an encrypted overlay; one attached server at a time.

Tailscale/WSL2 setup and the `tailscale serve` loopback caveat are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Contributor setup, the dev harness and its probe modes, two-device acceptance,
publishing, and manual verification live in
[`CONTRIBUTING.md`](CONTRIBUTING.md).
