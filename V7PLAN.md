# subplug V7 — remote access (brainstorm)

Status: **brainstorm / not started.** Supersedes the earlier standalone
`subplug-v2` draft, which wrongly proposed a new plugin. subplug is **already a
v2 plugin**; V7 is a delta on its `v2` branch. The branch is checked out in
`C:\Users\weaka\opsesh` (`v7-remote` @ `12c3586`). Baseline green on Windows
(2026-09-29): `bun install --frozen-lockfile`, `bun run canary` (host
`opencode v2.0.19` via `@opencode/cli@2.0.19`; installed plugin API matches the
host line), `bun run typecheck`, `bun test` (168 pass / 0 fail).

## Goal

Work with opencode sessions running on other devices on the local network as if
working on the machine the server is running on. Scope is **plugin-only** (no
core changes).

## Key facts that shape V7

Path note: `src/…`, `scripts/…`, `test/…` are this repo (subplug); `packages/…`,
`specs/…` and `~/opencode` refer to the opencode workspace checkout.

- subplug `v2` branch is the port target: HEAD `12c3586 "Port subplug to opencode
  v2"` (2026-09-29), `@opencode/plugin ^2.0.19`, server + TUI entries.
- v2 execution is **server-side** (`specs/v2/session.md` "Execution Is
  Process-Local"), so attaching to a remote server already runs tools/shell/files
  on the server machine. "As if local" is inherent to v2; V7 makes subplug render
  and drive it correctly.
- subplug's state is a **local filesystem hub** written by the server plugin and
  read by the TUI plugin. Across devices those filesystems do not converge.
- The remote-attached TUI **already receives live remote data**: `ctx.data.session.*`,
  `ctx.client.*`, and `ctx.data.on(...)` events (`src/tui/index.tsx:787-823`);
  today it only backfills `session.created` into the local hub
  (`src/tui/data.ts:132-180`). So the fix is to render primarily from
  `ctx.data`/`ctx.client` and treat the hub as local enrichment.
- `remote access` is explicitly out of scope in the v2 web-view section
  (`PLAN.md:1047`), so V7 is the natural next phase.

## Git instructions

Bring the subplug `v2` branch into this project folder (`C:\Users\weaka\opsesh`).
The folder already holds this plan as `V7PLAN.md` (renamed from `PLAN.md` so it
cannot collide with the repo's own tracked `PLAN.md`). Use the in-place route,
which leaves `V7PLAN.md` untracked; run these from `C:\Users\weaka\opsesh`.

```powershell
# In-place: create the repo here, then materialize the v2 branch.
git init
git remote add origin https://github.com/tfisatypedef/subplug.git
git fetch origin
git switch -c v7-remote origin/v2

# Alternative: clone to an empty path, then move the plan back.
#   Move-Item C:\Users\weaka\opsesh\V7PLAN.md C:\Users\weaka\V7PLAN.md
#   git clone --branch v2 https://github.com/tfisatypedef/subplug.git C:\Users\weaka\opsesh
#   Move-Item C:\Users\weaka\V7PLAN.md C:\Users\weaka\opsesh\V7PLAN.md
# Offline: the local checkout `C:\Users\weaka\subplug` tracks only `main`, which
# sits at the same commit, so clone `--branch main` from that path instead.

# Confirm branch + commit.
git branch --show-current        # expect: v7-remote
git log --oneline -1             # expect: 12c3586 Port subplug to opencode v2

# Install dev dependencies and baseline the gates. Needs a v2 host on PATH:
#   npm i -g @opencode/cli@dev   (or set OPENCODE_BIN; see README:260-268)
bun install
bun run typecheck
bun test
bun run canary                   # host major >= 2 + matching @opencode/plugin line
```

Notes:

- The repo is Bun-based (`bun test`, `bun run typecheck`, `bun run canary`,
  `prepublishOnly`).
- The v2 CLI ships as the `opencode2` binary; the canary prefers it so a v1
  `opencode` on PATH does not shadow it (`scripts/opencode-bin.ts`).
- Keep `origin` on GitHub for upstream merges; commit V7 on `v7-remote`.
- Windows: `scripts/opencode-bin.ts` picks the extensionless npm shim from
  `where`, which async `spawn` cannot execute (ENOENT; canary's `spawnSync`
  tolerates it, the harness does not) — set
  `OPENCODE_BIN=%APPDATA%\npm\opencode2.cmd` before `bun run harness`. Spike ran
  green with it (2026-09-29): server ready, plugin `subplug` active with
  server+tui features, live tap + identity, hub pointer matches.

## Two-device architecture (target)

- **Device A (server):** `OPENCODE_PASSWORD=<pw> opencode2 serve --hostname
  0.0.0.0 --port 4096`. `OPENCODE_PASSWORD` is canonical for both sides
  (`OPENCODE_SERVER_PASSWORD` is a legacy alias still honored); with no env
  password a foreground serve generates and prints one.
- **Device B (client):** `OPENCODE_PASSWORD=<pw> opencode2 --server
  http://<A-ip>:4096`. The TUI + subplug operate on A's sessions/filesystem.
- subplug should show A's sessions with live status/cost, switch/cycle them,
  read transcripts, and (per scope decision) drive them.

## Auth / keys

- No key management. The server core refuses to start without a password
  (`~/opencode/packages/server/src/process.ts:51-52`); the CLI takes it from
  `OPENCODE_PASSWORD` (legacy alias `OPENCODE_SERVER_PASSWORD`) or generates and
  prints one (`~/opencode/packages/cli/src/server-process.ts:78-84,164`). Clients
  use Basic `opencode:<password>`
  (`~/opencode/packages/cli/src/services/server-connection.ts:25-29`).
- In attach-first mode the plugin manages nothing: it inherits the endpoint and
  auth header through `ctx.client`/`ctx.data`. One static password on the host is
  enough on a trusted LAN — plain-HTTP Basic auth is sniffable, so LAN only.
- Credentials in plugin options are only needed for a future second-server panel
  (deferred). No SSH keys (start is manual).

## Proposed V7 phases (plugin scope)

- **V7.0 — probe.** Two-device harness (serve on A, attach on B with subplug).
  Record into this file: (a) which `ctx.data.session.*` fields arrive remotely
  (list/get/status/root/family/cost, message sync), (b) status latency and event
  delivery (`session.idle`, `execution.*`), (c) `ctx.client.server.info()` local
  vs remote output, (d) which `ctx.client.*` methods exist on the attach
  (`listNativeSessions` already probes `session.list` optionally), (e) `hubDir` /
  `repoRoot` resolution on B, (f) transcript path (store vs
  `client.session.context`), (g) follow-up send + whether comms injection fires
  server-side. *Accept:* all seven recorded.
- **V7.1 — remote detection + scoping.** Detect via `ctx.client.server.info()`
  (`GET /api/info` → `{ version, pid, urls, paths.tmp }`): when bound `0.0.0.0`
  the `urls` are the server machine's LAN interfaces, so "no `urls` entry matches
  my loopback/local interfaces" ⇒ remote. Do not use `pid` as identity (changes
  per restart); `ctx.location.directory` is the remote path string, not a local
  path. Scope hub records so remote sessions never merge with local ones —
  preferred: a `remote` mode in `SubplugTuiOptions` (`src/tui/context.ts`,
  alongside `storageDir`/`hubGroup`) that bypasses the hub.
- **V7.2 — hub-independent TUI state.** Build the dashboard from
  `ctx.data.session.*` (list/status/cost/family) as the primary source. The hub
  cannot be "local enrichment" on a remote attach: `resolvePaths` prefers a local
  `hub.json` pointer (7-day max age, written by a server plugin that ran here)
  and otherwise keys from the *remote* project id (`src/tui/index.tsx`,
  `src/hub/paths.ts`), and `repoRoot` from `ctx.location.directory` won't exist
  locally. Remote ⇒ bypass the hub and degrade explicitly; enumerate consumers
  (dashboard fold, claim join, risk toasts, details pane) and surface "claims
  unavailable on remote". Comms pointers are server-side too (`injectComms`,
  `src/server/index.ts`), so remote injection cannot come from the client hub.
  This is the bulk of the work.
- **V7.3 — remote transcripts + actions.** Verify transcripts via
  `loadTranscriptV2` (store → `ctx.client.session.context`) against a remote;
  route follow-up/composer (and any new actions) through `ctx.client`.
- **V7.4 — start-remote docs + status line.** Document the two commands;
  optionally show the attached endpoint in the dashboard. Manual only, no SSH.
- **V7.5 — tests.** Fake-context remote tests + a live two-process/LAN check;
  `bun test`, `bun run typecheck`, canary.

## Open decisions (unresolved)

1. **Scope of control.** subplug is read-only + opt-out queue-only comms. Does V7
   add **full control** (create/interrupt/shell/compact/agent+model switch) on the
   remote, or keep the read-only + comms posture and only make it work remotely?
   *Recommended:* keep read-only + comms for V7 — the follow-up path already goes
   through `ctx.client.session.prompt` and survives the attach unchanged; full
   control is a separate product decision (V8).
2. **Remote detection.** Automatic when the endpoint is non-loopback, or an
   explicit option (`remote: true` / `servers`)? Should the dashboard ever show
   local and remote sessions together, or one attached server at a time?
   *Recommended:* automatic detection (V7.1) plus an explicit override; one
   attached server at a time (the TUI cannot switch servers at runtime).
3. **Hub scoping.** Server-scoped hub key vs a hub-free remote path.
   *Recommended:* hub-free remote path first (smallest change, no wrong data);
   server-scoped keys only if remote history must be recorded locally.

## Out of scope

- Multi-server aggregation, in-plugin second-server panel, SSH auto-start,
  web-view parity, npm publish of a new package.
