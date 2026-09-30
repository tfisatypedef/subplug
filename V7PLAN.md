# subplug V7 — remote access (brainstorm)

Status: **V7.1–V7.5 implemented (V7.0 probe done); V7.R0 review fixes and V7.R1
probe landed; single-machine execution and task-child acceptance pass on
`opencode` 2.0.20; two-device (LAN or overlay) acceptance is in progress — the
probe items pass over Tailscale and the visible UI checks remain.**
Open decisions answered (see "Resolved decisions"); scope locked
to read-only + comms with a hub-free remote. Supersedes the earlier standalone
`subplug-v2` draft, which wrongly proposed a new plugin. subplug is **already a
v2 plugin**; V7 is a delta on its `v2` branch, checked out in
`C:\Users\weaka\opsesh` (`v7-remote`, based on `origin/v2`). Gates green on
Windows (2026-09-29): `bun run typecheck`, `bun test` (188 pass / 0 fail),
`bun run canary`, and harness `spike` / `--tui` /
`--probe-tui-state [--attach] [--probe-execute] [--probe-task]
[--probe-tools] [--probe-replay]` / `--demo` / `--inspect`.
Re-verified green on Linux (WSL2/Ubuntu, 2026-09-30, Bun 1.3.3, opencode
2.0.20): the same gates plus the local `npm pack` whitelist and the full
harness matrix. Cold-start probe timing races in the late-subscriber live
delivery and attach message-store hydration were hardened. The V7.R2 runbook is
in README's "Two-device acceptance (LAN or Tailscale)". A two-device attach
(Windows host over Tailscale, Linux/WSL client) exposed a remote rendering bug:
the dashboard enumerated only the reactive store, so pre-existing server
sessions were invisible; remote enumeration now uses `client.session.list()`
with the store as fallback (`b94919b`, suite 190).

## Goal

Work with opencode sessions running on other devices on the local network or an
encrypted overlay (e.g. Tailscale) as if working on the machine the server is
running on. Scope is **plugin-only** (no core changes).

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
  (`src/tui/data.ts:132-180`). The fix is to render remotely from
  `ctx.data`/`ctx.client` **without the hub**: a remote attach must not read or
  write the local hub (the hub cannot be "local enrichment" when `hubDir`/
  `repoRoot` resolve to paths on the server). Local attaches keep the hub
  unchanged. See "State sources" below.
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
- Windows: `scripts/opencode-bin.ts` resolves the npm `.exe`
  (`@opencode/cli/bin/opencode.exe`) from the extensionless/`.cmd` shim on the
  `where` result, so `bun run scripts/dev-harness.ts` works without setting
  `OPENCODE_BIN`. (Previously the extensionless shim failed under async `spawn`
  with ENOENT; the canary's `spawnSync` tolerated it, the harness did not.)

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
  enough on a trusted LAN or an encrypted overlay (Tailscale): plain-HTTP Basic
  auth is sniffable, so it is only safe on a trusted network or an encrypted
  transport, never a shared one.
- Credentials in plugin options are only needed for a future second-server panel
  (deferred). No SSH keys (start is manual).

## Proposed V7 phases (plugin scope)

- **V7.0 — probe. DONE (2026-09-29, single-machine two-process harness).**
  Findings recorded below. The two-device pass still needs a machine with a
  configured model/provider for event-latency items; everything else is measured.
  Run it with `OPENCODE_BIN=%APPDATA%\npm\opencode2.cmd bun run
  scripts/dev-harness.ts --probe-tui-state [--attach] [--keep]`; bind/connect
  hosts via `SUBPLUG_HARNESS_HOST` / `SUBPLUG_HARNESS_CONNECT`.
- **V7.1 — remote detection + scoping. DONE (2026-09-29).** Detect via `ctx.client.server.info()`
  (`GET /api/info` → `{ version, pid, urls, paths.tmp }`): when bound `0.0.0.0`
  the `urls` are the server machine's interfaces (LAN and overlay), so "no `urls`
  entry matches my loopback/local interfaces" ⇒ remote. Limitation: a server
  bound to `127.0.0.1` and fronted by a proxy (e.g. `tailscale serve`) advertises
  loopback, which every client matches locally, so auto-detection returns local;
  bind `0.0.0.0` behind the proxy or force `remote: "remote"`. Do not use `pid`
  as identity (changes per restart); `ctx.location.directory` is the remote path
  string, not a local path. Scope hub records so remote sessions never merge with local ones —
  preferred: a `remote` mode in `SubplugTuiOptions` (`src/tui/context.ts`,
  alongside `storageDir`/`hubGroup`) that bypasses the hub.
- **V7.2 — hub-independent TUI state. DONE (2026-09-29).** Build the dashboard from
  `ctx.data.session.*` (list/status/cost/family) as the primary source, with
  `client.session.list()` for enumeration so pre-existing server sessions appear
  (the reactive store only holds sessions learned about since attaching;
  `b94919b`). The hub
  cannot be "local enrichment" on a remote attach: `resolvePaths` prefers a local
  `hub.json` pointer (7-day max age, written by a server plugin that ran here)
  and otherwise keys from the *remote* project id (`src/tui/index.tsx`,
  `src/hub/paths.ts`), and `repoRoot` from `ctx.location.directory` won't exist
  locally. Remote ⇒ bypass the hub and degrade explicitly; enumerate consumers
  (dashboard fold, claim join, risk toasts, details pane) and surface "claims
  unavailable on remote". Comms pointers are server-side too (`injectComms`,
  `src/server/index.ts`), so remote injection cannot come from the client hub.
  This is the bulk of the work.
- **V7.3 — remote transcripts + actions. DONE (2026-09-29; store-first transcripts are hub-free, actions route through `ctx.client`).** Verify transcripts via
  `loadTranscriptV2` (store → `ctx.client.session.context`) against a remote;
  route follow-up/composer (and any new actions) through `ctx.client`.
- **V7.4 — start-remote docs + status line. DONE (2026-09-29; README "Remote attach"; dashboard and sidebar show "remote attach · claims unavailable").** Document the two commands;
  optionally show the attached endpoint in the dashboard. Manual only, no SSH.
- **V7.5 — tests. DONE except the LAN pass (2026-09-29).** Fake-context remote
  tests in `test/remote.test.ts` (detection, mapping, hub-free state); the
  single-machine two-process probe passes (`--probe-tui-state --attach`); plus
  `bun test`, `bun run typecheck`, and canary. A two-device LAN latency check
  still needs a second machine with a configured model.

## V7.0 findings (2026-09-29)

Probe: `scripts/probe-tui-state/tui.ts`, driven by `--probe-tui-state [--attach]`.
Local server `opencode2 serve` (v2.0.19) + TUI attached with `--server <url>`,
both processes on one machine. Raw report: `state/probe/tui-state-probe.json`.

- **(a) Remote `ctx.data.session.*` hydrates fully.** On the attach,
  `data.session.list()` returns the server's sessions, `get` hits, and
  `status` / `cost` / `root` / `family` all answer. `message.sync(id)` then
  `message.list(id)` populated the store (1 message for the probed child), while
  `client.session.context(id)` returned 0 rows (the run admitted a prompt but no
  model executed, so there was no assistant context). **Go for V7.2: build the
  dashboard from `ctx.data`/`ctx.client`; no hub needed.**
- **(b) Status latency + events: deferred.** No model/provider is configured in
  the harness, so prompts are admitted but never execute: cost stayed 0 and no
  `session.idle`/`execution.*` fired. Needs a configured model on the server
  side; automated once a provider is available.
- **(c) `server.info()` output.** Loopback bind → `urls: ["http://127.0.0.1:P"]`.
  Bind to one LAN IP → `urls: ["http://<that-ip>:P"]`. Bind `0.0.0.0` → `urls`
  enumerates the machine's LAN interfaces and **omits loopback**
  (`["http://100.x.x.x:P", "http://172.x.x.x:P", …]`). So a remote host's urls
  will not match any local interface ⇒ the V7.1 heuristic holds. `pid` is present
  but not used as identity.
- **(d) `ctx.client.*` on the attach.** `session.create`, `session.prompt`,
  `session.context`, and `session.list({limit})` all worked through the attach
  (the probe used every one). `session.list` is present (not undefined).
- **(e) `hubDir` / `repoRoot` on the attach.** `ctx.location.directory` is the
  **server** repo path (`...\Temp\subplug-harness\repo`) even though the TUI runs
  locally; `findRepoRoot` on it is meaningless client-side. Confirms hub-free
  remote.
- **(f) Transcript path.** Store (`message.sync`+`list`) is the primary and is
  reachable remotely; `client.session.context` is the fallback (0 rows here
  because nothing executed). `loadTranscriptV2` already prefers the store.
- **(g) Follow-up send.** `client.session.prompt` over the attach returned an
  admitted message id (server-side delivery), so the read-only + comms path
  survives the attach. Comms injection itself is server-side (`injectComms`) and
  runs in the server process; it is unaffected by the client attach.

## Resolved decisions (2026-09-29)

1. **Scope of control:** read-only + opt-out queue-only comms. No
   create/interrupt/shell/compact/agent+model switch in V7. The follow-up path
   already goes through `ctx.client.session.prompt` and survives the attach
   unchanged; full control is a separate product decision (V8).
2. **Remote detection:** automatic (V7.1) plus an explicit `remote` override.
   One attached server at a time — the TUI cannot switch servers at runtime, so
   local and remote sessions are never shown together.
3. **Hub scoping:** hub-free remote. A remote attach reads and writes no local
   hub (smallest change, no wrong data). Server-scoped hub keys are deferred
   until remote history must be recorded locally.

### State sources

`createMonitor` (`src/tui/index.tsx:137-211`) selects one of two sources behind
the existing `state()` signal; the dashboard, sidebar and details pane are
unchanged:

- **local** (default): `readMonitorState(hubDir, repoRoot)` exactly as today.
- **remote**: synthesize `MonitorState` from the attached server only — no hub
  read, no backfill, no hub logging, empty `risks`/`recentCommands`/`comms`, and
  an empty `registry` (claims/verifications/conflicts unavailable). Enumeration
  uses `client.session.list()` (`listNativeSessions`) because the reactive
  `ctx.data.session` store only carries sessions the client learned about since
  attaching; the store is the fallback when the native list is empty. Without
  this, pre-existing server sessions were invisible (`b94919b`).

Remote `SessionNode` mapping:

| SessionNode | remote source |
| --- | --- |
| `sessionID` / `parentID` | `client.session.list()` `id` / `parentID`, else `ctx.data.session.list()` |
| `kind` | `parentID ? "subagent" : "root"` |
| `title` / `agent` / `model` / `directory` | `SessionInfo` fields (`location.directory`) |
| `status` | `ctx.data.session.status()` (store only): `running → busy`, `idle → idle`, otherwise `unknown` |
| `cost` | `ctx.data.session.cost(id)`, falling back to the listed `cost` |
| `lastEventAt` | `time.updated` |
| `identity` | never — so claims cannot join |

UI must degrade explicitly: claim/conflict counts (`dashboard.tsx:186-188`),
sidebar sessions+claims (`index.tsx:263-304`), details claims/rollup/inbox/
command (`details-pane.tsx:26-36`), identity line (`index.tsx:443`), risk toasts
(`index.tsx:182-196`), plus skip backfill (`index.tsx:156-173`) and follow-up
hub logging (`index.tsx:587-596`).

### Detection (V7.1)

`resolveTuiOptions` gains `remote?: "auto" | true | false`, default `"auto"`.
Auto uses `ctx.client.server.info().urls` versus the local interface hosts
(`node:os.networkInterfaces()`); secondary signal is whether
`ctx.location.directory`/`findRepoRoot` exists locally. Probe once, cache, and
fall back to **local** if `server.info()` rejects. Explicit `true`/`false`
overrides the heuristic.

## Out of scope

- Multi-server aggregation, in-plugin second-server panel, SSH auto-start,
  web-view parity, npm publish of a new package.

## Remaining work specification (2026-09-29)

This section is the current V7 completion checklist. V7.1–V7.5 feature code
is implemented. The older probe results established hydration and prompt
admission, not model execution or event latency; a real two-device run over
Tailscale has since established remote detection, model execution, the
task-child link and the busy/idle latency, and found two fixes. V7.R0 and V7.R1
are committed on `v7-remote`; the suite passes 190 tests with `bun run
typecheck` clean. Single-machine execution and task-child acceptance pass on
`2.0.20` (see V7.R1 below); the two-device visible UI checks remain pending
(see V7.R2).

### V7.R0 — review fixes and regression coverage

Implemented: failed remote status lookups preserve `unknown` (so sending
requires confirmation); IPv6 URL brackets are removed before local-host
comparison; session-detail polling is cleared on disposal and late responses
cannot update a disposed view or a different selected session.

- [x] Failed-status and IPv6-loopback checks in `test/remote.test.ts`.
- [x] Typecheck and full suite: 188 pass, 0 fail (186 at R0; 2 backfill
  edge-case tests added in PLAN R2).
- [x] Add a focused lifecycle test that closes a detail view, verifies no
  subsequent transcript polling, and resolves an in-flight load after closing.
- [x] Exercise an unknown remote status through the composer: cancellation
  sends nothing; confirmation uses `queue`.

Acceptance: these tests execute the production component/composer and pass
without a provider. Keep this work within the existing TUI test fixtures.

### V7.R1 — execution-capable probe

Extend the development harness/probe; do not add product controls. Today
`--probe-tui-state --attach` launches both processes on one machine and the
probe sends `resume: false`. It is not a completed two-device test.

- [x] Reuse the production remote-detection helper in the probe, including
  IPv6 handling, rather than maintaining a second heuristic.
- [x] Add an explicit execution mode with a selected configured model and
  one bounded scratch task. Preserve the provider-free hydration mode.
- [x] Add an existing-server attach mode for a client on a second device.
  It must not seed/delete the server workspace, spawn another server, or
  stop a server it did not create. Accept the endpoint and authentication
  through the environment; print the exact client launch instructions.
- [x] Subscribe before prompting; record prompt admission, execution events,
  store status changes, transcript appearance, and cost when reported.
- [x] Write a JSON result with host/plugin versions, session IDs, observation
  times, durations, test outcomes, and redacted errors. Omit credentials,
  message bodies, and full tool output. Apply bounded waits; failures exit
  nonzero and an unavailable provider is an explicit incomplete result.

Acceptance: a configured model completes a scratch run on the same machine
through an attached TUI; the result distinguishes admission from execution,
shows busy then idle, and confirms an assistant transcript. The probe must
remain optional; normal tests and CI need no model credentials.

Probe code and R0 tests are implemented locally. Two-device acceptance
remains pending; it is not established by typecheck or the provider-free
hydration mode.

Single-machine acceptance on opencode `2.0.20` (Windows, 2026-09-29, plugin
`0.2.0`/`0.3.0`, model `opencode/nemotron-3.5-lightning-free`), all
`outcome: pass`: the provider-free `--attach` hydration mode, the client-only
`--existing-server` mode (against a separately started local server it left
running), `--probe-execute` with a configured model, `--probe-task` with a real
task-created child, and `--probe-tools` asking for one `swarm_status` call.
Execution evidence: admission 25 ms, busy observed
after `session.execution.started`, idle after `session.execution.succeeded`,
assistant transcript present, ~4.8 s wall time. Task evidence: the child's
`session.created` carries `parentID` and `agent`; the child's `parentMatches`
is true and the folded hub node is `kind: subagent` with
`parentID` = root, `agent: general`, `model`, and a distinct coordination
identity. Tool evidence: the assistant content records a direct `swarm_status`
tool entry (no `execute` Code Mode wrapper), while `session.tool.called/failed`
events carry no tool name. `--probe-execute` without a model returned
`outcome: incomplete` and
a nonzero exit, as intended. These checks contain no LAN status-latency
evidence (item (b) stays deferred) and no failure/interruption/retry path.

### V7.R2 — two-device acceptance (LAN or Tailscale)

Prerequisites: R1, two devices reachable over the LAN or an encrypted overlay
(e.g. Tailscale), a server with a configured model, and subplug loaded — with
its runtime dependencies installed — in the server and the client TUI. Start
the server manually using README's Remote attach instructions; prefer a direct
tailnet address, and if you front it with `tailscale serve`, bind `0.0.0.0` (see
V7.1's detection limitation). Run the client probe against that server, then
perform the visible UI checks on the same session.

- [x] Auto-detection selects remote; dashboard/sidebar indicate remote attach.
  Claims/conflicts/history/inbox remain explicitly unavailable, and client
  hub files are unchanged across monitoring and follow-up sends. Met for
  detection and the unavailable claims/history (probe `remote: true` every run;
  the user confirmed the dashboard footer). The follow-up-send hub check rides
  with the follow-up item below.
- [ ] Observe a real root and a real task-created child with the correct
  parent link; navigate to both and inspect their transcript updates. The
  parent link is probe-verified (`parentMatches: true`); the dashboard
  navigation and transcript inspection are still pending.
- [x] Collect at least five busy/idle transitions across bounded runs. Measure
  client event receipt to visible status using one client clock. Target:
  each visible update within two configured polling intervals plus 500 ms.
  Report missed transitions separately; do not infer network latency from
  unsynchronized server/client clocks. Eight transitions over four runs; see
  the evidence below.
- [ ] Verify an idle-target follow-up resumes execution; a busy-target send
  asks for confirmation, cancellation sends nothing, and confirmation queues
  one native message. Check eventual consumption in the target transcript.
- [ ] Verify the applicable failure event produces one toast/attention
  notification, and a child completion produces its completion notification.
- [ ] Disconnect/reconnect the client: no cross-contamination with a local hub,
  no crash, and remote sessions/transcripts recover on reattach.

Evidence (2026-09-30; server: Linux host over Tailscale, client: WSL2/Ubuntu;
`opencode` 2.0.20, plugin 0.3.0, model `opencode/longcat-2.5-preview-free`;
client probe `--probe-tui-state --existing-server`):

- Hydrate: `remote: true`, `outcome: pass`, `errors: []`; the server listed 7
  sessions while the reactive store held 2 — the store-only enumeration bug.
- Execute (four bounded runs): all `remote: true`, `outcome: pass`, admission
  14–110 ms, assistant transcript present, busy then idle each run. Eight
  status transitions total. `execution.started → running` 253/355/281/285 ms
  and `execution.succeeded → idle` 0/187/121/142 ms, all well inside two
  polling intervals (1 s default) plus 500 ms.
- Task: `remote: true`, `outcome: pass`, a real child with
  `parentMatches: true`, `sawTaskChild`/`sawBusy`/`sawIdleAfterBusy` true,
  `hubFoldSkipped: true`, `errors: []`.
- The run found and fixed two defects: remote enumeration now uses
  `client.session.list()` with the store as fallback (`b94919b`), and the task
  probe no longer requires a local hub fold on a hub-free client (`8ef1843`).

Still open: the visible follow-up confirm/queue, toast/attention and
disconnect/reconnect checks, dashboard navigation and transcript inspection,
and the failure/interruption/retry path.

Runbook: README "Two-device acceptance (LAN or Tailscale)". It was rehearsed
single-machine
(2026-09-30) against a server bound to the client's non-loopback interface: the
server-side plugin inventory check (`serverPluginLoaded`) and the client plugin
check both pass in hydrate mode, and the endpoint/firewall steps work. The
server loads subplug from a `v7-remote` checkout (or, to validate the npm
artifact, the packed tarball); pin both sides to the same commit before the run
(`13434f0` at the time of writing). That rehearsal does **not** establish
remote detection (`remote` stays `false` when the endpoint is a local
interface), model execution, or the UI items; those still need the real second
device and a configured model.

Acceptance: preserve a redacted JSON report plus a short manual-check record
with device OS, versions, polling interval, outcomes, and observed limitations.
Mark V7 complete only when this run passes. If the second device or provider
is unavailable, retain this checklist as pending rather than substituting
single-machine results. Any failed check gets a reproducible issue and a
targeted fix before repeating the affected check.

### Completion and next scope

- [ ] Record R0–R2 evidence and update the headline completion status and test
  count. Keep historical results intact and label their host versions.
- [ ] Follow the v2 release checklist appended to `PLAN.md`; publishing is
  a separate release decision and is not required to prove V7 behavior.

No V8 implementation is specified here. Creating/interruption controls,
shell/compact/model switching, multiple servers, remote claim transport,
and SSH startup require a separate scope decision.
