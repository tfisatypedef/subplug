# subplug — plan

An opencode plugin that lets a session monitor the other sessions and subagents
working on a project, overlaid with the `coordination/` claim registry.

Status: **P0–P5 complete; P6 (cross-process + portability) partially
implemented**. Server tap, session fold, coord bridge, `swarm_status`
(text/json/tree + inbox pull), `swarm_send`, queue-only inbox-notice injection,
`shell.env` identity injection, TUI sidebar/route/toasts, the nested session
tree with collapse/rollups, the store-backed transcript, session cost folding,
the TUI composer/inbox, a timeout-guarded state-dir fallback, and a shared-hub
`hubGroup` are in place. Remaining: live `task`-subagent observation and visual
TUI checks (see "Implementation status"), the optional web view, and final
packaging (publish decision).

Follow-up context: the dashboard and detail offer `f`/`m` plus a clickable
**[f] Follow up** action. TUI and tool sends share delivery logic: check live
status, confirm queueing for busy/retrying agents, and resume idle agents via
the native async prompt endpoint without waiting for their response. Both
write redacted metadata pointers to the hub; full context stays in the native
session. Startup discovers descendants recursively (50 recent starting
sessions, 200 sessions total), and native `task` metadata updates recover live
child links, agent names, and models even if creation events were missed.

## Locked decisions

- **API**: v1 server hooks + v1 TUI plugin, pinned to `@opencode-ai/plugin` /
  `@opencode-ai/sdk` `1.18.32` (the installed runtime). The experimental
  `./v2/effect` API is not used unless a demonstrated need appears.
- **Module shape**: server and TUI are two entries, not one. The type surface
  is mutually exclusive — `PluginModule = { server; tui?: never }` and
  `TuiPluginModule = { tui; server?: never }` — so `src/server/index.ts` and
  `src/tui/index.ts` are separate modules. The TUI entry renders **SolidJS**
  (`@opentui/solid`) JSX, not React.
- **Scope**: local machine, per project. Cross-clone / cross-window aggregation
  is deferred to P4+.
- **Mode**: viewing stays read-only. P5 adds a **comms tier** that is enabled by
  default, queue-only, addressed, and message-initiated by a human or an agent
  tool; no abort, no steer, no gating of other sessions. **v1/flat SDK for both
  reads and writes** on v1 sessions (`session.prompt`/`promptAsync`,
  `session.messages`, `session.todo`, `session.children`). The v2
  `/api/session/...` endpoints are a separate durable store and are not used
  until sessions are v2-driven (see probe results).
- **Storage**: hub root derived from opencode's own state dir (TUI:
  `api.state.path.state`; server: derive from `directory`/`worktree`), NOT a
  hardcoded `~/.local/share`. Per-server append-only JSONL plus a folded
  snapshot under `<hub>/subplug/<projectID>/`. A `storage: "project"` override
  to `<directory>/.subplug/` can come later.
- **Hub is the only shared state**: the server plugin and TUI plugin run in
  different processes/bundles with no shared memory. They converge only on the
  filesystem hub. Mirror `coord.py`'s journal pattern: `O_APPEND`, one file per
  server, project to a folded snapshot (`coord.py:240-297`); the TUI polls/tails
  to meet the ~1s freshness target.
- **Identity**: `coord.injectIdentity` defaults to `false`. When enabled, the
  server plugin sets `COORD_AGENT_ID` via the `shell.env` hook (transient
  process env only — never writes a file) only when it is unset and the repo is
  coordination-enabled. Values follow coord's convention: root sessions share
  `<name>@<host>`; subagents get `<name>@<host>/<sessionID8>` — a unique,
  stable child id. Depth-based `/wN` was rejected because sibling subagents
  would collide, which `coordination/README.md` convention 3 forbids. The
  injected value is recorded as a `session.identity` event so readers can join
  sessions to claims; without injection the mapping falls back to heuristics.
- **UI order**: sidebar slot first, dashboard route second, toasts/attention
  third.

## Verified surface

- Docs: `https://opencode.ai/docs/plugins/`, `/docs/sdk`, `/docs/config`.
  TUI settings live in `tui.json` (global or project), schema
  `https://opencode.ai/tui.json`.
- Local type files to mirror (opencode 1.18.32): the installed
  `@opencode-ai/plugin` `dist/{index,tui}.d.ts` and `@opencode-ai/sdk`
  `dist/gen/types.gen.d.ts`.
- Server hooks: `event` (global bus), `tool.execute.before/after`
  (`{tool, sessionID, callID}`), `chat.message`, `shell.env`, `permission.ask`,
  `tool` (custom tools), `experimental.session.compacting`.
- TUI API: `api.event.on`, `api.state.session.*`, `api.ui.Slot`
  (`sidebar_content`, `sidebar_title/footer`, `session_prompt_right`),
  `api.ui.toast`, `api.route.register`, `api.keymap`,
  `api.attention.notify` (has a `subagent_done` sound), `api.client`.
- Session data: `Session.parentID` (field), children via `api.client.session`
  `children()` (`GET /session/{id}/children`) — NOT `api.state.session.children`
  (`TuiState.session` has no children accessor); statuses `idle|busy|retry`,
  events `session.status/idle/error`, `todo.updated`.
- Config: `.opencode/plugins/` autoload; npm via `plugin: []`;
  `OPENCODE_CONFIG_DIR` for a scratch config dir; `subagent_depth` defaults to 1.

## Layout

```
subplug/
  package.json           # bun; @opencode-ai/plugin pinned 1.18.32; @opentui/* for TUI types
  tsconfig.json
  src/server/index.ts    # event tap -> hub; shell.env identity inject; swarm_status tool
  src/tui/index.tsx      # sidebar slot, dashboard route, toasts/attention (SolidJS)
  src/hub/               # store paths, append, rotation, fold, monitor merge, comms
  src/coord/             # claims reader/fold/conflicts, glob, repo discovery
  src/shared/            # normalized records, redaction
  scripts/dev-harness.ts # scratch config + seeded repo; headless server + TUI checks
  test/                  # bun test: coord, hub, redact, tree, transcript, server
  PLAN.md README.md
```

## Data model

- `EventRecord`: `{ ts, serverID, sessionID, parentID, kind, summary, refs }`.
- `SessionNode`: `{ sessionID, parentID, kind: root|subagent, agent, model,
  identity, title, directory, status, lastEventAt }`.
- `ClaimRecord`: parsed `coordination/claims/*.jsonl` claim events with folded
  status, expiry, scopes.
- `MonitorState`: folded sessions + `risks` (recent `command.risk`) + registry;
  `joinClaimsToSessions` maps active claims to sessions by `identity`.
- `CommsPointer`: `{ ts, serverID, from, to, msgID, kind, delivery, state,
  summary }` stored as `comms.sent`/`comms.delivered`/`comms.seen` event
  records; metadata only, bodies stay in the native session store.
- Redaction: metadata only by default; no message bodies, no secrets.

## Phases and acceptance

- **P0 — scaffold and load spike.** Answer: (a) how TUI plugins load
  (`tui.json` `plugin` vs `plugins/` dir vs separate spec), (b) whether one
  module may export server + TUI or needs two entries, (c) whether local-file
  plugins receive config options. *Accept*: opencode starts with the spike
  plugin loaded and its marker written; answers recorded here.
- **P1 — server tap.** Event normalize -> hub; session tree from
  `list/children` + events; retention; `swarm_status` custom tool;
  `shell.env` identity injection behind the flag. *Accept*: harness run with a
  root + `task` subagent yields correct parent/child records and `swarm_status`
  JSON; hub replays after restart.
- **P2 — TUI.** Sidebar "Agents" slot, then dashboard route, then
  toasts/sounds. *Accept*: two live sessions + a subagent visible; updates
  within ~1s; toast on session error.
- **P3 — coordination bridge.** Read `coordination/claims/*.jsonl` (fallback
  `coord.py list --json`); overlay claims/expiry/conflicts/needs-test; watch
  `tool.execute.before` bash for `git commit|push|coord` and toast warnings
  (never gate). *Accept*: seeded registry shows claims, expiry countdown,
  conflict badge, commit-without-coverage warning.
- **P4 — viewing subagents.** Tree rendering, live transcripts (full parts),
  rollups, `swarm_status` tree format, on-demand context/diff. Read-only.
  *Accept*: a root→subagent tree renders nested with collapse state; a running
  subagent's tool call updates live in detail; rollups show subtree cost and
  busy/error counts; `swarm_status format=tree` returns the tree; unit tests
  cover the pure helpers.
- **P5 — session comms.** Composer in the dashboard/detail, `swarm_send` tool,
  inbox pull, and bounded context injection using the native synthetic-part
  pattern. Queue-only, metadata-only hub pointers, bodies never in the hub.
  *Accept*: sending to an idle subagent creates a durable user message in that
  session and a `comms.sent` pointer; a reply is pullable via `swarm_status`;
  injection is a no-op with an empty inbox; harness probes pass (see below).
- **P6+ — cross-process.** Aggregate multiple clones/windows; optional web view.
  Partial: windows on the same project share a hub automatically; clones
  aggregate via a shared `storageDir` + `hubGroup`; the web view is not started.

## Risks

- Plugin API drift: pin 1.18.32 and add a canary check.
- TUI slot/API stability; attention sounds are new surface.
- SolidJS (`@opentui/solid`) renderer is unfamiliar territory vs React.
- `shell.env` `sessionID` is optional (`index.d.ts:242-248`); identity injection
  must not collapse two sessions onto one identity when it is absent.
- Privacy defaults and storage retention.
- Windows path/EOL parity.
- Mapping quality when `COORD_AGENT_ID` is absent.
- ~~Default-on comms contradicts the read-only language in README, package.json,
  and the `swarm_status` description (`server/index.ts:663`); update all three.~~
  Resolved in P5: all three now describe the opt-out, queue-only comms tier.
- ~~Injection runs on the model-request critical path and `readEventRecords`
  re-parses every JSONL per call; needs memoized folds and a timeout/skip path.~~
  Resolved in P5: the server keeps an in-memory comms fold updated on append and
  replay; `chat.message` reads only that map after the memoized `ensure()`.
- Cross-session content is untrusted input; frame as data, never inject via
  the system prompt by default.
- Agent-to-agent loops and token burn: addressed-only, no auto-reply, hop
  cap <= 2, per-session send caps.
- Busy sends are confirmed (`swarm_send` refuses without `confirm: true`; the TUI
  composer asks first) and are consumed at the next step boundary.
- ~~`comms.*` records must not flow through `fold.ts`'s default `ensure()` path.~~
  Resolved in P5: `comms.*` cases are explicit fold no-ops.
- ~~Plugin-appended parts need ascending ids (the runtime mints them); a random
  id may sort oddly in the transcript.~~ Probed in P5 (`--probe-inject`): the
  runtime persists our synthetic part; time-prefixed ids sorted after the native
  part on this build.

## P0 findings

Confirmed against opencode 1.18.32 with the dev harness (scratch
`OPENCODE_CONFIG_DIR`, seeded repo, headless `opencode serve` + TUI start):

- **(a) TUI loading**: TUI plugins are declared in `tui.json`
  `plugin: [[spec, options]]` (relative or absolute path); the runtime reads
  `config.plugin_origins ?? TuiConfig.pluginOrigins()`. `.opencode/plugins/`
  autoload covers the server kind; the TUI kind comes from the plugin config.
- **(b) module shape**: a plugin module must **default-export an object** with
  exactly one of `server` or `tui` — `{ id, server }` or `{ id, tui }`. Path
  plugins **must** export `id`; a module exporting both is rejected
  (`readV1Plugin`, `resolvePluginId`). Packages may expose `exports["./server"]`
  and `exports["./tui"]` for entrypoint resolution. Two entries confirmed.
- **(c) options plumbing**: the `[spec, options]` tuple reaches both
  `server(input, options)` and `tui(api, options, meta)`. Verified live:
  `{ coord: { injectIdentity: true }, storageDir }` drove identity injection.
- **Install mechanism (verified)**: `opencode plugin <spec>` reads the package
  `exports["./server"]` / `exports["./tui"]` (plus `main`/`oc-themes` fallbacks)
  and patches both `.opencode/opencode.json` and `.opencode/tui.json`; `--global`
  targets the global config and `--force` replaces an entry. Verified with
  `opencode plugin /path/to/subplug` ("Detected server + tui targets")
  followed by a `serve` probe that loaded the installed config.
- **Deadlock finding**: calling `input.client.path.get()` (an HTTP round-trip
  back into the same server) eagerly during plugin `server()` init stalls
  bootstrap. Bootstrap is now fire-and-forget and every hook awaits the
  memoized `ensure()` instead.
- **Harness finding**: Bun `fetch` without a timeout can hang while the server
  bootstraps; readiness probes need `AbortSignal.timeout` and retries.
- **Evidence**: `bun run scripts/dev-harness.ts` → root probe `Harness Agent@<host>`,
  a child session created with `parentID` probes `Harness Agent@<host>/<childID8>`,
  the child folds as `subagent`, `session.identity` is recorded, `swarm_status`
  is present in `/experimental/tool/ids`; `bun run scripts/dev-harness.ts --tui`
  → `tui-plugin-loaded.json` marker written by the TUI entry;
  `test/server.test.ts` drives the real hooks (coverage risk + identity).
  Manual modes: `--demo` (seeded TUI check), `--poke-risk` (live toast),
  `--inspect` (folded view for the real `task` test).

## P4/P5 design — viewing subagents + session comms

### Decisions

- Comms is both UI (compose from the overlay) and context injection (replies
  can land in the current session's context).
- Write tier enabled by default; queue-only delivery; no steer; no broadcast.
- Message bodies never enter the hub. Hub records are metadata pointers only
  (`from`, `to`, `msgID`, `kind`, `delivery`, `state`, redacted `summary`).
- v1/flat SDK for both reads and writes. The TUI maintains two stores: the
  sync store backing `api.state.session.*` (v1 `Message`/`Part`, global maps
  keyed by id) and a durable `session.next.*` store keyed by `sessionID`;
  neither is assumed for subplug, which reads the flat client.
- Target policy: idle/background subagents and roots by default; busy targets
  require an explicit confirm; in-flight synchronous children are refused with
  an offer to promote them to background (`experimental.session.background`).

### Verified mechanics (opencode 1.18.32, binary inspection)

- `experimental.chat.system.transform` is awaited in `LLMRequestPrep.prepare`
  with `{sessionID, model}` and appends strings to `system[]`; each string
  becomes its own trailing system message. It also fires for small-model calls
  (`prepare` handles `e.small`) and compaction, so it is on the request
  critical path and must be treated as a guarded, opt-in substrate.
- `experimental.chat.messages.transform` fires in the normal loop and during
  compaction with `{}` input and the whole message list; it can add synthetic
  model messages but has no sessionID input.
- `chat.message` output parts are persisted (`updatePart` per part) and
  `TextPartInput.synthetic` exists. It fires for subagent turns too, because
  the `task` tool drives children through `SessionPrompt.prompt`.
- `session.prompt` with `noReply: true` persists the user message and returns
  without running a turn; without `noReply` it calls `ensureRunning`, so a busy
  session picks the message up at the **next step boundary of the same run**
  (the loop re-reads the message stream each iteration and exits only when the
  latest assistant's `parentID` equals the latest user message id).
- `task` subagents run inside the parent's tool call (awaited, AbortController)
  and can be promoted to background. A completed background subagent already
  injects a synthetic text part into the parent via
  `TaskTool.injectBackgroundResult` with `Ur({sessionID, state, summary, text})`
  framing; the task output reports `task_id: <childID>`. Mirror this shape.
- `fold.ts` `applyRecord`'s default branch calls `ensure()` for any record with
  a `sessionID` (fold.ts:87-91). New `comms.*` records must be fold-inert or
  they will resurrect deleted sessions and reorder the dashboard.

### Probe results (harness, opencode 1.18.32)

`bun run scripts/dev-harness.ts --probe-comms`:

- A v1 `noReply: true` prompt to a **busy** child is admitted (HTTP 200) and
  persisted in the v1 message list; the child reports `busy` while the long
  shell runs.
- A v2 `/api/session/{id}/prompt` with `delivery: "queue"` on the same
  v1-created session is also admitted (HTTP 200, `admittedSeq`), but the
  message appears only in the **v2 durable store** (`/api/session/{id}/context`)
  and never in the v1 message list; the v1 loop never consumes it. v2 and v1
  are parallel engines: do not mix v2 writes with v1 sessions.
- Ordering after the shell: `[user(shell), assistant(shell), user(noReply)]`.

`bun run scripts/dev-harness.ts --probe-tui-state`:

- `api.state.session.messages(childID)` returns a non-current, subagent
  session's message (1) from the in-process store; `api.state.session.get`
  resolves it. Live transcript can read the store instead of polling.
- `api.state.session.count()` only includes sessions with content: the empty
  root session is absent (`get(rootID)` false). Render metadata from the hub
  for empty sessions and transcript from the store when present.
- `api.state.part(messageID)` works for a non-current subagent message (the
  probe records `childStoreParts: 1`, type `text`), so the store path covers
  parts as well as messages.

`bun run scripts/dev-harness.ts --probe-inject`:

- A `comms.sent` pointer written into the hub while the server is stopped is
  replayed into the in-memory comms fold on restart; the next user message to
  the addressed child gets ONE synthetic text part appended in `chat.message`.
- The part persists in the v1 message list with `synthetic: true` and the
  inbox framing; observed part ids were native `prt_0e854a0ad...` then injected
  `prt_mulbjhzv...` (the injected id sorts after the native one on this
  runtime, so transcript order is preserved).
- The plugin records `comms.delivered` for the injected pointer.

### Harness notes from probing

- A zombie `opencode serve` left by a failed run held port 4599 and answered
  later harness runs with stale code, causing misleading failures (missing
  plugin options, no hub, no identity). The harness now picks a random per-run
  port, kills stale listeners before spawn, retries startup, and kills the
  process group.
- `SUBPLUG_SKIP_BASELINE=1` skips the baseline import; useful for probes that
  need a quiet hub.

### Corrections to the earlier brainstorm

- "Queue = no mid-loop disruption" is false; queue means "next step boundary"
  and can interleave with in-flight work. Hence the busy-target confirm.
- Do not sum `step-finish` tokens for context %; each step's input already
  includes the whole context. Sum cost only; use last/max input for %.
- v2 is **not** safe for reads on v1 sessions either: it is a separate store.
  Use the flat client (what the TUI's `api.state.session` sync store mirrors)
  for both reads and writes until sessions are v2-driven.

### Hub records (metadata only)

```
comms.sent      {from, to, msgID, kind, delivery:"queue", summary:redacted}
comms.delivered {to, msgID, at}
comms.seen      {by, msgID, at}
```

Written with a per-process `serverID` file like other events; readers fold all
files. `readEventRecords` re-reads and re-parses every JSONL per call, so the
injection path needs a memoized/incremental fold before it can run per model
call.

### P4 scope

1. Tree: nested rendering via `sessionDepth`; collapse state in `api.kv`;
   Enter descends; breadcrumb back-stack; orphan/deleted markers; show
   `task_id`.
2. Transcript: full parts (text, reasoning folded, tool with
   `state.status`/`title`/elapsed/output tail, file/patch). Source:
   `api.state.session.messages()/part()` (probe-confirmed for non-current
   sessions with content), falling back to the flat client
   `api.client.session.messages({ sessionID })` for sessions not in the store.
   Do not use the v2 store for v1 sessions.
3. Rollups: subtree cost, busy/error descendant counts, per-child last tool and
   age.
4. `swarm_status`: add `tree` format; keep excerpts opt-in.
5. On demand: flat `session.messages` (context window), `session.todo`,
   `session.children`, `session.diff`; keep the hub for metadata.

### P5 scope

1. Composer: dashboard/detail key -> `DialogPrompt` -> v1 `session.prompt`.
2. `swarm_send` tool (accepts `session` or `task_id`) + inbox pull folded into
   `swarm_status`.
3. Injection: synthetic text part on the target context (native pattern), or
   guarded `system.transform` later. Default-on (`comms.inject`) but a strict
   no-op when the inbox is empty; addressed; deduped by msgID; TTL'd pointers;
   capped bytes; short fetch timeout that skips on failure. **Shipped as a
   framed pointer notice** in `chat.message`: the body already lands natively via
   `session.prompt`, so injection announces pending pointers, marks them
   `comms.delivered`, and leaves bodies in the native store.

### Probes (harness)

- `--probe-comms` (done): create root + child; start a long shell on the child;
  send v1 `noReply` and v2 `/api/session/{id}/prompt` while busy; await; report
  admission status, message order, and v2 context interop. Results above.
- `--probe-tui-state` (done): probe TUI plugin creates a root + child, sends a
  `noReply` message, and writes `api.state.session.count()` plus
  `messages(rootID).length` / `messages(childID).length` to a marker file.
  Results above.
- Manual: spawn a background subagent and read the parent transcript to capture
  the native `Ur(...)` injection framing.

### Test seams

Pure `buildSessionTree`, `rollupSubtree`, `resolveTargets`, and
`buildInboxBlock` helpers so `test/hub.test.ts`-style unit tests cover the
logic; the harness only proves hooks fire and pointers land.

## Implementation status

| Piece | Status | Evidence |
| --- | --- | --- |
| Scaffold (`package.json`, `tsconfig`, exports) | done | `bun run typecheck` 0 errors |
| Hub append/rotate/replay/fold | done | `test/hub.test.ts` (9 tests) |
| Coord reader/fold/conflicts/coverage | done | `test/coord.test.ts` (12 tests) |
| Redaction + command categorization | done | `test/redact.test.ts` (3 tests) |
| Server tap + `swarm_status` + identity inject | done | `test/server.test.ts` + harness spike |
| Unique subagent identity + `session.identity` | done | child-session proxy in the harness; identity unit test |
| Claim↔session join + commit coverage risk | done | `test/server.test.ts` (covered/uncovered/non-risky) |
| Baseline session import at bootstrap | done | `test/server.test.ts` (imports + skips stale) |
| `swarm_status` session detail (`session`, opt-in `messages`) | done | `test/server.test.ts` (detail + message gating) |
| TUI selection + `subplug.session` detail route | load-verified | TUI marker from `--tui`; visual check pending |
| TUI sidebar/route/risk toast (SolidJS) | load-verified | TUI marker from `--tui`; `--demo` seed for visual check |
| Real `task` subagent run | user-run | prompt + `--inspect` documented in README |
| Visual TUI + toast/attention behavior | user-run | `--demo` + `--poke-risk` documented in README |
| Harness robustness (random port, stale kill, retry, XDG isolation) | done | baseline spike stable; zombie cause documented |
| Probe: busy-session admission + v1/v2 store split | done | `--probe-comms` (see results) |
| Probe: plugin store coverage for subagents | done | `--probe-tui-state` (see results) |
| P4 viewing implementation | done | `test/tree.test.ts` + `test/transcript.test.ts` pure helpers; cost fold in `test/hub.test.ts`/`test/server.test.ts`; TUI tree/rollups/transcript + `swarm_status format=tree`; `--tui` load; visual check user-run |
| P5 comms implementation | done | `test/comms.test.ts` pure helpers; `swarm_send` + inbox-pull tests in `test/server.test.ts`; injection `--probe-inject`; TUI composer/inbox `--tui` load; visual check user-run |
| Probe: injection part persistence + `comms.delivered` | done | `--probe-inject` (see results) |
| P6 cross-process + portability | partial | state-dir timeout guard + hang test; multi-server fold test; `hubGroup` in server + TUI; CI (`.github/workflows/ci.yml`), `.gitattributes`, LICENSE, `bun.lock`, engines already present; web view not started |
| P6 review fixes | done | degenerate hub keys -> `unknown`; non-positive timeout guard; globally newest record limit; `EventTail` fresh-comms injection; spike/`--tui`/`--probe-inject` green |
| TUI layout + sidebar affordance | done | rows/panels constrained to full width, conversation clipped; explicit `flexShrink={0}` on labels/rows/panels stops auto-shrink overlap on short terminals (`flexShrink` defaults to 1 for auto dimensions); sidebar hint + click-to-open; `test/tui.test.tsx` static layout/click/short-terminal tests (note: `@opentui/solid` `testRender` is snapshot-only, async updates do not repaint) |

## P6 review fixes

Four review findings fixed post-P6, one per commit (baseline 80 tests):

| Fix | Change | Evidence |
| --- | --- | --- |
| Degenerate hub keys | `sanitizeProjectID` strips trailing dots/spaces and maps `""`, `.`, `..`, `...` to `unknown`, so `hubGroup` can no longer escape `<storageDir>/subplug/`. | `test/hub.test.ts` sanitize cases |
| Non-positive state-dir timeouts | `stateDirTimeoutMs` ignores `<= 0`/non-finite env values and keeps the 1500 ms default; exported for a direct unit test. | `test/server.test.ts` timeout table |
| Global record limit | `readEventRecords` keeps the globally newest `maxRecords` across all files with a bounded `(ts, seq)` min-heap instead of stopping in lexical file order; `maxRecords: 0` returns `[]`. | `test/hub.test.ts` cross-file limit + tie tests |
| Stale comms fold | `EventTail` seeds byte-offset/identity cursors per hub file before the initial replay and reads only new bytes on `chat.message`; rotation/shrink resets, partial lines are held, `msgID` dedupe makes re-reads idempotent. | `test/hub.test.ts` EventTail tests; `test/server.test.ts` post-bootstrap pointer injection; `--probe-inject` |

## Handoff prompt for a fresh window

> Read PLAN.md. P0–P5 are implemented and committed. P5 (session comms) adds
> `src/hub/comms.ts` (fold/inbox/resolveTargets/buildInboxBlock) with unit
> tests; `swarm_send` (`session`/`task_id`, busy-confirm, 5/min cap);
> `swarm_status inbox: true` pull with `comms.seen`; inbox-notice injection in
> `chat.message` (`comms.inject`, in-memory comms fold, dedupe/TTL/byte caps,
> marks `comms.delivered`); and the TUI `m` composer plus the detail Inbox
> panel. Automated gate: `bun install; bun run typecheck; bun test` (97 pass);
> `bun run scripts/dev-harness.ts`; `bun run scripts/dev-harness.ts --tui`;
> `--probe-comms`; `--probe-tui-state`; `--probe-inject`. The user still runs
> the README manual checks: `--demo --keep` + `opencode` for the visual
> tree/collapse/rollups/transcript/inbox/composer check and a real `task`
> prompt + `--inspect`. P6 is partially implemented: `resolveStateDir` is
> timeout-guarded (hang test), the hub folds multiple server logs (test), and
> `hubGroup` (server + TUI, `SUBPLUG_HUB_GROUP`) lets clones share a hub via a
> shared `storageDir`; CI, `.gitattributes`, LICENSE, `bun.lock`, and engines
> already exist. The P6 review fixes are also in (see "P6 review fixes"):
> degenerate hub keys map to `unknown`, non-positive state-dir timeouts are
> ignored, `readEventRecords` keeps the globally newest records with a bounded
> `(ts, seq)` heap, and `EventTail` tails only new hub bytes before inbox
> injection (seeded before the initial replay). The TUI rows/panels are
> width-constrained, the conversation panel clips overflow, and the sidebar has
> a click/`ctrl+alt+a`/`/subplug` open hint; explicit `flexShrink={0}` on
> detail labels/rows/panels prevents auto-shrink row overlap on short terminals;
> `test/tui.test.tsx` covers the static layout, the sidebar click, and the
> short-terminal clipping. Remaining P6: the optional web view and the publish
> decision.
> Keep using the flat client for v1 sessions (never the v2 `/api/session`
> store), read transcripts from `api.state.session.messages()`/`part()` when
> the store has content, keep `client.path.get()` out of eager plugin init, and
> keep comms queue-only/addressed with metadata-only hub pointers. Harness
> gotcha: random port, kill stale listeners; a zombie serve answers with stale
> code.
