# subplug — plan

An opencode plugin that lets a session monitor the other sessions and subagents
working on a project, overlaid with the `coordination/` claim registry.

Status: **P0–P5 complete; P6 (cross-process + portability) partially
implemented**. Server tap, session fold, coord bridge, `swarm_status`
(text/json/tree + inbox pull), `swarm_send`, queue-only inbox-notice injection,
`shell.env` identity injection, TUI sidebar/route/toasts, the codex-style
command center (filter tabs, grouping, search, help, details pane) with
Enter-to-switch, a store-backed transcript, session cost folding,
the TUI composer/inbox, a timeout-guarded state-dir fallback, and a shared-hub
`hubGroup` are in place, a live `task` subagent is observed end to end by
`--probe-task`, and the optional web view is implemented (`web.enabled`,
localhost-only). Publish prep is done (0.1.0, `files` whitelist,
`prepublishOnly`, `bun run canary`); remaining: the interactive visual TUI
checks (see "Implementation status") and the actual npm publish decision.

Follow-up context: the dashboard and detail offer `f`/`m` plus a clickable
**[f] Follow up** action. TUI and tool sends share delivery logic: check live
status, confirm queueing for busy/retrying agents, and resume idle agents via
the native async prompt endpoint without waiting for their response. Both
write redacted metadata pointers to the hub; full context stays in the native
session. Startup discovers descendants recursively (50 recent starting
sessions, 200 sessions total), and native `task` metadata updates recover live
child links, agent names, and models even if creation events were missed.

## OpenCode v2 migration (branch `v2`) — plan

Status: **v2 port complete (V0–V6 done, 2026-09-29); V7 remote attach
implemented on `v7-remote`; branch ready to merge.** This section describes this
branch. The v1 sections below describe `main` (the
shipped 1.18 plugin) and stay as the historical reference. Development ran
against `@opencode/cli@dev` (`0.0.0-dev-20288`, 2026-09-29) and the release
host `@opencode/cli` `2.0.20`; see the V0–V6 results sections.

Current status (2026-09-29): the v2 port (V0–V6) and the V7 remote-attach
feature are implemented. `v7-remote` adds hub-free remote render/actions
(V7.1–V7.5) plus review fixes (V7.R0) and probes (V7.R1) whose single-machine
execution and task-child runs pass on `2.0.20`; PLAN R1, R2 and R4 are done.
Remaining: V7.R2 two-device LAN acceptance (needs a second device), PLAN R3
visual checks (needs an interactive terminal), and PLAN R5 release
preparation. See "Current remaining work specification" at the end of this
file and `V7PLAN.md`.

Scope: port subplug to opencode **2.x only** — server plugin plus CLI/TUI plugin.
No dual `server()`/`setup()` package; v1 support remains on `main`. Reference
surface read from the opencode `origin/v2` branch (`7ef4a1a56e`; local worktree)
and the published `@opencode/plugin@2.0.19`. Runtime under test:
`@opencode/cli@dev` (the v2 CLI; `opencode-ai` and `@opencode-ai/*` are the v1
line) with `@opencode/plugin@2.0.19`.

### Verified v2 surface (source of truth for the port)

- Package: `@opencode/plugin@2.0.19`, exports `.` (Promise server), `./tui`
  (CLI/TUI), `./effect`, `./host`, `./*` (`packages/plugin/package.json:12-18`).
- Definition: `export default Plugin.define({ id, setup })`; `setup(ctx)` may
  return a cleanup. The loader requires the default export to be an object with
  `id` plus `effect` or `setup` (`packages/plugin/src/promise/plugin.ts:56-65`,
  `packages/core/src/plugin/module.ts:60-116`).
- Server context domains: `app`, `location`, `options`, `storage`, `agent`,
  `command`, `event`, `integration`, `mcp`, `model`, `generate`, `permission`,
  `plugin`, `provider`, `reference`, `rpc`, `session`, `shell`, `skill`, `tool`,
  `vcs`, `websearch`, `worktree` (`packages/plugin/src/promise/plugin.ts:26-54`).
  There is **no `ctx.client`** and no `directory`/`worktree`/`$` at the top
  level; use `ctx.location` and the domain methods.
- Events: `ctx.event.subscribe({ signal })` yields `OpenCodeEvent` with payloads
  under `event.data` (`packages/schema/src/session-event.ts`,
  `packages/schema/src/event-manifest.ts`). Relevant names: `session.created`
  (carries `parentID`, `projectID`, `title`), `session.deleted`,
  `session.renamed`, `session.agent.selected`, `session.model.selected`,
  `session.status` (`data.status`: idle|busy|retry), deprecated `session.idle`,
  `session.execution.*`, `session.step.*`, `session.text/reasoning/tool.*`,
  `session.usage.updated`, `session.compaction*`, `session.inbox.*`,
  `permission.asked/replied`. **Gone:** `session.updated`, `message.updated`,
  `message.part.updated`, `session.error`, `todo.updated`, `command.executed`
  (only ephemeral `command.updated` for the command list).
- Session domain (`packages/plugin/src/promise/session.ts:153-170`): `create`,
  `get`, `switchAgent`, `switchModel`, `prompt` (`delivery: "steer"|"queue"`),
  `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`, `wait`,
  `context`. **No** list, children, status, todo, message-list, or environment.
- Hooks (`packages/plugin/src/promise/{session,tool,shell,permission}.ts`):
  `session.hook("prompt"|"context"|"compaction"|"generate"|"title"|
  "model.request"|"http.*"|"retry")`, `tool.hook("execute.before/after")`,
  `shell.hook("create.before")`, `permission.hook("evaluate")`. Throwing from
  `tool.execute.before` denies the call (`packages/core/src/plugin/hooks.ts`).
- Tools: `ctx.tool.transform(editor => editor.add({ name, description, input,
  execute }))` with JSON Schema/Standard Schema input and `{ content }` results;
  `list()`/`reload()`/`registration.dispose()`
  (`packages/plugin/src/promise/tool.ts`).
- Shell hook event: `{ command, cwd, timeout, shell, env }` — **no sessionID**
  (`packages/plugin/src/promise/shell.ts:3-17`;
  `packages/core/src/shell.ts:256-275`). v2 sets the per-session shell env via
  `PUT /api/session/:id/environment`
  (`packages/protocol/src/groups/session.ts:866-884`), reachable from the TUI
  context's `client` but not from the server context.
- TUI: `Plugin.define({ id, setup(context) })` from `@opencode/plugin/tui`
  (`packages/plugin/src/tui/plugin.ts`); context = `options`, `location`,
  `app`, `renderer`, `client`, `data`, `attention`, `theme`, `themeMode`,
  `markdown`, `keymap`, `storage`, `ui`
  (`packages/plugin/src/tui/context.ts:516-532`).
  - Slots: `app`, `home.footer(.status)`, `prompt.footer(.status|.file)`,
    `session.composer.top`, `session.panel`, `sidebar.content`, `sidebar.footer`
    with prepend/append/before/after/replace (`context.ts:191-262`).
  - Router: `register({ name, render({ data }) })`,
    `navigate({ type: "plugin"|"session"|"home" })`, `current()`
    (`context.ts:142-157,468-472`).
  - Keymap: `layer(() => ({ mode, priority, enabled, target, commands,
    bindings }))`; commands use `id`/`bind`/`palette`/`slash`/`run`
    (`context.ts:384-460`). Host keybinds come from `cli.json`.
  - Dialogs: promise `alert/confirm/prompt/select` plus `show/set/clear`; always
    modal (`context.ts:327-382`).
  - Data (reactive Solid stores): `data.session.{list,get,root,family,cost,
    status,message.list/sync,pending.list/sync,permission.list/sync,form.*}`,
    `data.project.*`, `data.shell.*`, `data.location.*`, `data.on/listen`
    (`context.ts:31-140`). Content is embedded in messages; there is no parts
    API and no todo.
  - Storage `storage.store/memory(key, { initial })` is per-plugin namespaced
    (`context.ts:31-53`); theme tokens changed
    (`packages/theme/src/tui/types.ts`).
- Loading: server config `plugins: ["pkg" | { package, options }]`
  (`packages/schema/src/config/plugin.ts:6-14`); directories
  `.opencode/plugin(s)` and global `plugins/`
  (`packages/core/src/plugin/source-directory.ts:7`); configured local paths
  must be directories; server entry `server.ts`/`index.ts`, TUI entry `tui.ts(x)`
  or package `exports["./tui"]` (`packages/plugin/src/host.ts:17-44`). TUI
  config is global `cli.json`; the TUI also auto-loads server plugins that
  expose `./tui` (`packages/tui/src/plugin/context.tsx:99-103,301-305`).
- CLI: `opencode plugin add|list|check|update|remove`
  (`packages/cli/src/commands/commands.ts:241-284`). There is no `engines`
  check in v2; compatibility means depending on the matching `@opencode/plugin`
  line. `opencode serve` now requires Basic auth (`opencode:<password>`), serves
  `/api/*`, and takes `--print-logs` plus `OPENCODE_LOG_LEVEL`.

### Server mapping (v1 → v2)

| v1 | v2 |
| --- | --- |
| default `{ id, server }` | `Plugin.define({ id: "subplug", setup(ctx) })`; cleanup returned |
| `input.{ client, project, directory, worktree, $ }` | `ctx.location.{ directory, project }`, `ctx.options`, `ctx.app`; no client or `$` |
| `event` hook | `for await (const event of ctx.event.subscribe({ signal }))` |
| `session.created/updated/deleted` | `session.created`, `session.renamed`, `session.metadata.updated`, `session.agent.selected`, `session.model.selected`, `session.deleted` |
| `session.status/idle/error` | `session.status` (`data.status`), deprecated `session.idle`, `session.execution.failed/succeeded/interrupted` |
| `todo.updated` | none — drop todos |
| `message.updated` (cost/agent/model) | `session.usage.updated`, `session.agent.selected`, `session.model.selected` |
| `message.part.updated` (`task`) | `session.created` (`parentID`) plus `session.tool.called/success/failed` |
| `command.executed` | none — drop |
| `chat.message` part injection | `ctx.session.hook("prompt", event => …)` and/or `ctx.session.synthetic` |
| `tool.execute.before/after` | `ctx.tool.hook("execute.before/after")` |
| `shell.env` (had `sessionID`) | `ctx.shell.hook("create.before")` — **no sessionID** (see gaps) |
| `tool()` + zod | `ctx.tool.transform` + JSON Schema, `{ content }` result |
| `client.session.list/children/status/todo/messages` | `ctx.session.get/context`; status folded from events |
| `client.session.prompt/promptAsync` | `ctx.session.prompt({ delivery })` |
| `client.app.log` | console/`process.stderr` (`[subplug]` prefix) |
| `client.path.get` state dir | XDG-derived state root (`storageDir`/env still win) |
| `$` git calls | `node:child_process` (or `Bun.$` when present); `ctx.vcs` where it fits |
| `dispose` hook | cleanup returned from `setup` (abort subscription, stop web, clear timer) |

### TUI mapping (v1 → v2)

| v1 | v2 |
| --- | --- |
| `{ id, tui(api, options, meta) }` | `Plugin.define({ id, setup(context) })` from `@opencode/plugin/tui`; no meta |
| `api.state.session.*`, `api.state.part` | `context.data.session.*`; content inline in messages |
| `api.state.provider.find` | `context.data.location.provider.list(location)` |
| `api.state.path.{ state, worktree }` | XDG-derived state root; `context.data.location.default().directory` |
| `api.client.*` (v1 SDK envelopes) | `context.client.*` (v2 generated client returns data, not `{ data }` wrappers) |
| `api.event.on` | `context.data.on` (`event.data` payloads) |
| `api.kv.get/set` | `context.storage.store(key, { initial })` (per-plugin namespace) |
| `api.ui.toast(x)` | `context.ui.toast.show(x)` |
| `api.ui.dialog.replace/clear` + `DialogPrompt`/`DialogConfirm` | `context.ui.dialog.prompt/confirm/alert/select` (promise, modal) |
| `api.route.register/navigate/current` | `context.ui.router.register/navigate/current` |
| `api.keymap.registerLayer` + `@opentui/keymap/extras` | `context.keymap.layer(...)` (`id`/`bind`/`slash`; host applies cli.json keybinds) |
| `api.attention.notify` | `context.attention.notify` (async, returns a result) |
| `api.slots.register({ order, slots })` | `context.ui.slot({ append: "sidebar.content", render })` |
| `api.theme.current` | `context.theme` (new token names) |
| `api.renderer` | `context.renderer` |
| `api.lifecycle.onDispose` | cleanup from `setup` / `onCleanup` in JSX |
| `tui.json` entry, `--probe-tui-state` | `cli.json` or auto-load via `./tui`; probe rewritten |

### Behavior changes and gaps to resolve

1. **Per-session shell identity.** v2's `create.before` has no `sessionID` and the
   server context cannot call `session.environment`. Plan: prefix
   `COORD_AGENT_ID=<identity> ` (properly shell-quoted) onto `bash` commands in
   `tool.execute.before` so agent-run `coord.py`/git commands resolve to the
   session identity, and keep recording `session.identity`. Optionally the TUI
   can push the variable with `context.client.session.environment(...)`, but
   that PUT replaces the whole session env and is client-side only — probe first.
2. **No session enumeration.** The v1 baseline import (`session.list` +
   recursive `children`) has no public v2 server equivalent. Sessions are
   tracked from `session.created`; previously folded hub records persist and can
   be revalidated with `ctx.session.get`. TUI can backfill
   `context.data.session.list()` metadata into the hub.
3. **Todos are gone.** Remove `todo.updated` handling, todo folding
   (`TodoSummary`), the `swarm_status` todo fields, and the detail Todos panel.
4. **Transcript shape changed.** v2 assistant messages embed content
   (text/reasoning/tool state). Rewrite `src/tui/transcript.ts` and the web
   transcript against `SessionMessage.Info` and `ctx.session.context`.
5. **Live-only events.** The plugin event stream does not replay history;
   startup starts empty and the hub supplies prior state. Keep the fold tolerant
   of unknown/partial records.
6. **`swarm_status` messages** move from `session.messages` to
   `ctx.session.context`.
7. **Send gating** uses the folded status map (from events) instead of a
   `session.status` API call.
8. **Delivery semantics (probed).** Idle targets start a turn when `prompt` is
   called without `resume: false`; busy targets admit durably and consume the
   item at the next step boundary (`delivery: "queue"`). `resume: false` admits
   without scheduling. Map idle → `session.prompt`, busy → `prompt` with
   `delivery: "queue"` behind the existing confirm.
9. **State dir.** Drop `client.path.get`; derive
   `<XDG_STATE_HOME|~/.local/state>/opencode` and honor
   `storageDir`/`SUBPLUG_STORAGE_DIR` first.
10. **Web server** stays `Bun.serve` but must be guarded for Node-hosted CLI
    (`typeof Bun !== "undefined"`).
11. **Options shape changes.** Keep `coord`, `storageDir`, `hubGroup`, `comms`,
    `web`; drop `keybinds` (host `cli.json` keybinds take over) and treat
    `enabled` as deprecated (host `plugin_enabled`/`-id` directives do this).
12. **Logging** loses `client.app.log`; use prefixed stderr/console.
13. **Code Mode wraps tools by default.** Registered tools are exposed through
    the built-in `execute` tool unless `options: { codemode: false }`. Inner
    calls still fire `tool.hook("execute.before")`/`"execute.after"`, and a
    denied inner call lands in the outer result's `metadata.toolCalls` and the
    model-visible text. Decide per tool whether `swarm_status`/`swarm_send` opt
    out of Code Mode.
14. **TUI options are separate.** A TUI entry loaded from server inventory gets
    `ctx.options = {}`; TUI options must come from `cli.json` (or be defaulted
    by the plugin). Server `opencode.json` options only reach the server entry.

### V0 probe results (2026-09-29, `@opencode/cli@dev` `0.0.0-dev-20288`)

Scratch workspace (not committed): `/tmp/opencode/v2-probe` with isolated
`XDG_*`, `OPENCODE_CONFIG_DIR`, `OPENCODE_PASSWORD`, a `git init` work dir, a
probe plugin dir (`server.ts` + `tui.ts` exporting plain `{id, setup}` objects
with no runtime imports), and the legacy `auth.json` copied into
`<data>/opencode/auth.json` (v2 imports it on first boot). Confirmed:

- **Loading**: config `plugins: [{ package: "/abs/dir", options }]` loads the
  server entry from a directory (`server.ts`); activation is lazy (first
  location use: session create + shell). `/api/plugin` then reports the plugin
  as `source: { type: "local", path: .../server.ts }` with
  `features: { server: true, tui: true }` once `tui.ts` exists. Options reached
  `setup(ctx)` unchanged.
- **Server context** matches the docs: domains exactly as listed above;
  `session` methods `hook/create/get/switchAgent/switchModel/prompt/generate/
  command/synthetic/interrupt/update/move/wait/context` (no list/children/
  status/todo/environment); `tool` has `list/transform/hook/reload`; `event`
  has only `subscribe`; `storage` has `get/set/remove/scan`.
- **Auth/API**: `opencode serve` prints `server listening on ...`; every request
  needs Basic `opencode:<OPENCODE_PASSWORD>` (401 otherwise). `/api/info`,
  `/api/config`, `/api/plugin`, `/api/session`, `/api/session/:id/context`,
  `/api/session/:id/shell`, `/api/session/:id/environment` (PUT),
  `/api/session/:id/synthetic`, and `/api/session/:id/prompt` all behaved as
  documented (204s or `{location, data}` JSON envelopes).
- **Shell hook**: `ctx.shell.hook("create.before")` fires for session shells;
  `event.env` is the full process env when no session env is set (else the
  session env), plus `TERM`/`OPENCODE_TERMINAL`, and has **no sessionID or
  callID**. Mutating `event.env` persists into the shell (verified
  `PROBE_SHELL_HOOK=1` in output).
- **Session environment**: `PUT /api/session/:id/environment {variables}`
  **replaces** the whole env (after the PUT only `variables` plus `TERM`,
  `OPENCODE_TERMINAL`, `PWD`, `SHLVL`, `_` remained; the process env was gone).
  There is no GET endpoint and no server-context method; only the TUI client
  exposes `session.environment`.
- **Prompts/delivery**: `POST .../prompt` durably admits
  (`session.inbox.enqueued`) and starts a turn on an idle session; `resume:
  false` admits without scheduling; `delivery: "queue"` waits for the next step
  boundary (a queued notice was delivered after a running turn continued and
  the model saw it). The `session.hook("prompt")` callback receives
  `{sessionID, messageID, prompt: {text}, delivery}` before admission and can
  rewrite both. `ctx.session.synthetic` admits a durable synthetic message
  (`session.inbox.enqueued`, type `synthetic`) that does not appear in
  `session.context` while pending.
- **Tools**: `ctx.tool.transform` registrations work; tools are exposed through
  the built-in Code Mode `execute` tool by default. Inner calls emit
  `tool.hook("execute.before")` (`{tool, sessionID, agent, messageID, id,
  input}`) and `execute.after` (`status: "completed"`, `result: {content}`).
  Throwing in `execute.before` denies the inner call: `execute.after` is
  skipped, the outer `execute` result's `metadata.toolCalls` records
  `{tool, status: "error"}`, and the denial text reaches the model.
- **Events** observed (in-process subscribe, server-wide): startup `*.updated`
  inventory events; `session.created` (root has no `parentID`);
  `session.execution.started|interrupted`;
  `session.step.started|streamed|ended|failed`;
  `session.text.started|delta|ended`; `session.reasoning.*`;
  `session.tool.input.started|delta|ended`,
  `session.tool.called|progress|success|failed` (outer Code Mode call; inner
  tools appear in `metadata.toolCalls` and hook records);
  `session.usage.updated`; `session.retry.scheduled`;
  `session.inbox.enqueued|delivered`; `session.shell.started|ended`;
  `shell.created|exited`; `session.instructions.updated`; `project.updated`.
  **Not observed on this build:** `session.status`, `session.idle`,
  `session.execution.succeeded|failed` (fold busy from
  `session.execution.started` plus `session.step.*`/inbox events until a
  release emits them), `todo.updated`, `command.executed`, `message.updated`.
- **Messages** (`GET /api/session/:id/context`): user
  `{id, time.created, text, type}`; assistant `{id, time, type, agent, model,
  content, snapshot, finish, rawFinish, cost, tokens}` with content entries
  `text`, `reasoning`, and `tool` (`{id, name, executed, state: {status, input,
  content, metadata}, time: {created, ran, completed}}`). No separate parts
  endpoint.
- **TUI**: loaded headlessly via `script -qec` + `--standalone`; the plugin
  auto-loaded from server inventory (`features.tui`) with `ctx.options = {}`.
  Context keys and client groups matched the docs; `theme.text.base` and
  `theme.border.base` are RGBA objects; `themeMode` is `"dark"`.
  `data.session.list()` was empty at boot even though `client.session.list()`
  returned all sessions — per-session `sync()` is required, so the hub remains
  the dashboard's source of truth.
- **Model runs**: free `opencode` Zen models with tools work
  (`nemotron-3-ultra-free` completed a turn with tool calls; 503 retries appear
  as `session.retry.scheduled`). One longcat turn hung and one dev-build server
  died after a forced interrupt; treat the dev binary as unstable.

Recipe for V5: `npm i @opencode/cli@dev`, serve with the env above, Basic auth
`opencode:$OPENCODE_PASSWORD`, readiness `GET /api/info`, sessions via
`POST /api/session`, shells via `POST /api/session/:id/shell`.

### Packaging and entrypoints

- `package.json`: dependency `@opencode/plugin: ^2.0.19`; remove
  `@opencode-ai/plugin`/`@opencode-ai/sdk`; peer-depend on `@opentui/core`,
  `@opentui/solid` (`>=0.5.12`) and `solid-js`; drop `@opentui/keymap`;
  `engines.opencode: ">=2"` (documentation only; v2 does not enforce it).
- `exports`: `"."` → server module, `"./tui"` → TUI module.
- Add thin root entry files `server.ts` and `tui.tsx` re-exporting
  `src/server/index.ts` / `src/tui/index.tsx` so the repo root is directly
  usable as a local directory plugin (v2 local paths must be directories);
  package installs resolve `"."`/`"./tui"`.
- Keep shipping TypeScript source and the JSONL hub format; add a build step
  only if the Node-hosted CLI must load the package.

### Phases

- **V0 — surface probe (done 2026-09-29; results above).** Scratch v2 run with
  `@opencode/cli@dev` under isolated XDG + `OPENCODE_CONFIG_DIR`, password set,
  Basic auth; a probe plugin directory (`server.ts` + `tui.tsx`) that records:
  module/options shape, event names and payloads, tool registration/execution,
  `execute.before` denial, prompt `delivery` behavior, shell env contents,
  `session.environment` PUT behavior from the TUI client, `data.session`/
  `message` shapes, storage behavior. *Accept:* findings written into this
  section; harness can boot v2 headlessly and observe a marker.
- **V1 — server shell + hub tap (done 2026-09-29; see "V1 results").**
  `Plugin.define` setup, options, XDG state dir, hub/EventLog reuse, event
  mapping (created/renamed/selected/status/usage/deleted), identity recording,
  cleanup. *Accept:* unit tests drive `setup` with a fake context and fold the
  same `EventRecord` kinds.
- **V2 — server tools + comms + leases (done 2026-09-29; see "V2 results").**
  `swarm_status`/`swarm_send` via `tool.transform`; `ctx.session.context`
  transcripts; inbox injection via the prompt hook; `delivery`-based sends;
  lease denial via `tool.hook`; coverage risk via child_process git; shell
  identity prefix. *Accept:* tool tests and lease-enforcement tests ported;
  empty inbox is a strict no-op.
- **V3 — TUI data layer (done 2026-09-29; see "V3 results").**
  `context.data` session/status/messages, storage, claim/hub reads; rewrite
  transcript, command-center, presentation for v2 types. *Accept:* pure-helper
  and fake-context tests pass.
- **V4 — TUI UI (done 2026-09-29; see "V4 results").** Sidebar slot, routes,
  keymap layers, promise dialogs, toasts/attention, theme tokens, follow-up
  composer, navigation/back-stack. *Accept:* `testRender` tests against a fake
  v2 context; visual check on the v2 CLI.
- **V5 — web view, harness, canary (done 2026-09-29; see "V5 results").**
  Web transcripts through `ctx.session.context`; harness v2 config (`plugins`
  object entries, local dir package, `cli.json` if needed), auth, `/api/*`
  readiness; canary asserts host major >= 2 and matching `@opencode/plugin`
  line; rewrite `scripts/probe-tui-state.ts`. *Accept:* `bun run canary --load`
  passes against the v2 binary.
- **V6 — docs + release (done 2026-09-29; see "V6 results").** README/PLAN
  updates (v2-only install, dropped todos, new options), version `0.2.0`, CI
  installs `@opencode/cli@dev`. *Accept:* `bun test`, `bun run typecheck`,
  canary, and the manual visual checks documented in README.

### V1 results (2026-09-29)

- The v2 shell lives in `src/server/v2.ts` while the v1 entry stays at
  `src/server/index.ts`; V2 ports tools/comms/leases into the v2 module, then
  renames it to `index.ts` and retires the v1 file/tests. This keeps `bun test`
  green across the port.
- `Plugin.define({ id: "subplug", setup })` with a structural `ServerContext`
  so tests drive `setupServer(fakeCtx)`; the real `Plugin.Context` is cast once
  in the adapter. `@opencode/plugin: ^2.0.19` is now a dependency.
- Options keep the v1 shape minus `keybinds`/`enabled`; state dir is
  synchronous (`storageDir` → `SUBPLUG_STORAGE_DIR` → XDG) because v2 has no
  `client.path.get`.
- Event mapping keeps the v1 `EventRecord` kinds: `session.created`,
  `session.renamed`→`session.updated`, `session.agent.selected`→`session.agent`,
  `session.model.selected`→`session.model`, `session.usage.updated`→
  `session.updated` (cost), `session.deleted`, `session.execution.started`→
  `session.status busy`, `succeeded|interrupted`→`session.idle`,
  `failed|step.failed`→`session.error`, `retry.scheduled`→`session.status retry`,
  plus the host's `session.status`/`session.idle` when present. The hub fold is
  unchanged.
- Identity recording moved from `shell.env` (no sessionID in v2) to
  `session.created`/first status per session, using each session's own
  directory; git `user.name` is read with `spawnSync` instead of the host shell.
- Baseline import is dropped: v2's server context cannot enumerate sessions
  (`list`/`children`/`status` are gone), so hub recovery relies on the shared
  event log and snapshot. TUI-side history (V3) can supplement.
- New `test/server-v2.test.ts` (10 tests) covers options, all mappings, the
  tap lifecycle/cleanup, hubGroup, XDG fallback, and identity. The v1 tests
  still pass; web view and tools/comms/leases remain v1 until V2/V5.

### V2 results (2026-09-29)

- The v1 server entry is retired: `src/server/index.ts` is now the full v2
  server (`Plugin.define`, event tap, tools, comms, leases) and root
  `server.ts` re-exports it. `src/server/render.ts` holds the pure renderers
  (`renderStatus`/`renderStatusTree`/`renderSessionDetail`); `web.ts` is
  untouched until V5.
- Tools register with `ctx.tool.transform((editor) => editor.add({...}))` using
  plain JSON Schema inputs (no zod dependency) and return `{ content, metadata }`.
  `swarm_status` reads transcripts through `ctx.session.context` (assistant
  content entries summarized as text + `[tool name status]`) and falls back to
  `ctx.session.get` when the hub does not know a ref.
- `swarm_send` resolves status from the folded hub and passes it to the new
  `sendFollowUp`: idle → `ctx.session.prompt` with `delivery: "steer"`, busy →
  `delivery: "queue"` behind `confirm`; the pointer records the host-assigned
  inbox id returned by `prompt`. Agent/model/variant preservation was v1 SDK
  behavior and is dropped (the host keeps them on the session).
- Inbox injection moved to `ctx.session.hook("prompt")` rewriting
  `prompt.text` (block appended); delivered markers are appended in the same
  hook. Empty inbox stays a strict no-op.
- Lease enforcement runs in `ctx.tool.hook("execute.before")` outside the
  monitoring catch, so denials still throw. Coverage risk and staged-path
  reads use `spawnSync` git instead of `Bun.$`; bash commands get a
  `COORD_AGENT_ID='...'` prefix from the same hook (v2's shell hook has no
  sessionID), with `session.identity` recorded on injection.
- The v1 TUI's follow-up composer still speaks the old transport; it now uses
  `src/shared/follow-up-legacy.ts` (deleted in V4) while `src/shared/follow-up.ts`
  is v2-only.
- Tests: `test/server.test.ts`, `test/lease-enforcement.test.ts`, and
  `test/follow-up.test.ts` were ported to the fake v2 context
  (`test/v2-context.ts`), which records tools/hooks and drives a controllable
  event stream. 166 tests pass, `tsc --noEmit` clean.
- Live smoke (isolated XDG + dev binary, repo loaded as a directory plugin):
  plugin activates from `/home/flub/subplug/server.ts` with
  `features: {server: true}`; options reach setup; live events land in the hub.
  **Gap found:** a session created concurrently with plugin activation is
  missed (no `session.created`). Since v2 has no server-side session listing,
  V3/V4 should backfill unknown sessions from the TUI client's
  `session.list()` into the hub (same pattern as the v1 baseline import).

### V3 results (2026-09-29)

- `src/shared/transcript.ts` gains `buildTranscriptRowsV2(messages, options)`:
  v2 assistant messages embed `content` entries (text/reasoning/tool) with
  `state.status` streaming|running|completed|error, `state.content` text blocks,
  and `time {created, ran, completed}`; user/synthetic/system/skill turns are a
  single text; compaction/retry/step rows come from the message itself. The v1
  parts builder is untouched until V4.
- `src/tui/data.ts` is the v2 data layer with structural types: store-first
  `loadTranscriptV2` (calls `data.session.message.sync`, falls back to
  `client.session.context`), `loadSessionDetailV2` (rows, max input+cache-read
  tokens, summed cost, `data.location.model.list()` context limit),
  `listNativeSessions`, `sessionNeedsInput` (permission/form lists), and
  `backfillSessions` — the TUI writes `session.created` records for native
  sessions missing from the hub, closing the activation-window gap found in V2.
- `src/tui/presentation.ts` gains `skinForTheme(theme)` mapping resolved v2
  tokens (`text.base/muted`, `text.action.primary`, `text.feedback.*`,
  `background.base/raised.base`, `border.base`) onto the existing `Skin`.
- Tests: `test/transcript-v2.test.ts` (6 cases) and `test/tui-data.test.ts`
  (5 cases: store/client/none, usage, needs-input, list unwrapping, backfill)
  plus a skin mapping case in `test/presentation.test.ts`. 179 tests pass,
  `tsc --noEmit` clean.
- V4 wiring: the dashboard/sidebar/detail move to `skinForTheme`,
  `loadSessionDetailV2`, `sessionNeedsInput`, `ctx.storage.store` for collapse/
  grouping, `ctx.ui.slot` claims, promise dialogs, `data.session.status()`, and
  hub backfill at startup; then the v1 TUI modules and
  `src/shared/follow-up-legacy.ts` are deleted.

### V4 results (2026-09-29)

- `src/tui/index.tsx` is now the v2 TUI entry (`Plugin.define({ id, setup })`)
  and root `tui.tsx` re-exports it, so the repo is directly loadable as a local
  v2 plugin for both entries.
- Ported UI: `Dashboard`/`SessionDetail`/`Sidebar`/`DetailsPane` take the
  structural `TuiContextLike` (`src/tui/context.ts`); the skin comes from
  `skinForTheme`; collapse/grouping persist through `ctx.storage.store`
  (`preferences` key — the v1 `kv` API is gone); search and busy-target
  confirmation use `ctx.ui.dialog.prompt/confirm`; toasts use
  `ctx.ui.toast.show`; routes are registered with arbitrary names and
  navigation uses `{type:"plugin", name, data}` / native `{type:"session"}`.
- Keymap: `ctx.keymap.layer` requires a component owner, so the global
  Ctrl+Alt+A / `/subplug` command lives in a headless `GlobalKeys` component
  claimed at the `app` slot; dashboard keys register inside `Dashboard` with
  `id`+`bind` commands (the v1 `@opentui/keymap` lookup is gone).
- Composer uses the v2 `sendFollowUp` directly (`steer` when idle, `queue`
  behind the promise confirm when busy), records the pointer with the host
  inbox id and removes `follow-up-legacy.ts`.
- Deleted v1 modules: `src/tui/transcript.ts`, `src/shared/follow-up-legacy.ts`,
  the v1 parts builder in `src/shared/transcript.ts`, and
  `test/transcript.test.ts`. `test/tui.test.tsx` was rewritten against the
  fake v2 context: layout/theme/marquee/details tests stay, commands are driven
  through the captured keymap layer (host dialog keyboard isolation is now the
  host's job), and the navigator tests call the function directly.
- Added the hub pointer bridge: the server writes
  `<XDG_STATE_HOME|~/.local/state>/opencode/subplug/hub.json` with the resolved
  hub, and the TUI reads it when it has no explicit `storageDir`. This fixes
  the mismatch found live: plugin options reach the server entry but not the
  TUI entry, so a `storageDir` option otherwise split them across hubs.
- Live check (isolated XDG, dev binary): TUI loaded from
  `/home/flub/subplug/tui.tsx`, `setup` completed in ~5ms, zero errors, marker
  written, hub pointer resolved to the server's storageDir hub. 166 tests
  pass, `tsc --noEmit` clean.
- Remaining: sidebar slot ordering after built-ins is still only `append`
  (unverified visually); `@opencode-ai/*`/`@opentui/keymap` dependencies and
  `exports`/`engines` are finalized in V6.

### V5 results (2026-09-29)

- Web view is wired into the server again: when `web.enabled`, the plugin
  starts the same `Bun.serve` dashboard with `readMonitorState` and a
  transcript built from `ctx.session.context` (summarized via
  `summarizeContextMessage`); unknown sessions 404 through
  `ctx.session.get`. `startWebServer` now returns a clear error when
  `typeof Bun === "undefined"` (Node-hosted CLI), and logging uses prefixed
  stderr. `test/server.test.ts` covers the transcript route end to end.
- Canary targets v2: it requires `@opencode/plugin` (major 2) installed,
  accepts release hosts with major >= 2 that satisfy the declared range, and
  detects `0.0.0-dev-*` nightlies so `--load` works against the dev binary.
  `resolveOpencodeBin` prefers `opencode2` (or `OPENCODE_BIN`) so a v1
  `opencode` on PATH no longer shadows the v2 host.
- Harness rewritten for v2: config uses `plugins` object entries pointing at
  the repo directory, `cli.json` carries the TUI-side entry (including
  `storageDir`, which `opencode.json` options do not propagate), `serve`
  requires Basic auth (`OPENCODE_PASSWORD`), readiness is `GET /api/info`,
  sessions come from `POST /api/session`, and the spike verifies the hub
  pointer, `server.start`/`session.created`/`session.identity` records, and an
  active inventory entry. Plugin activation is forced by polling
  `/api/plugin` before creating sessions (lazy activation otherwise races the
  first `session.created`).
- The harness workspace moved out of the repo (`SUBPLUG_HARNESS_DIR`,
  defaulting to `$TMPDIR/subplug-harness`): v2 watches local plugin sources,
  so state writes inside the repo retriggered plugin reloads.
- `scripts/probe-tui-state.ts` became the directory plugin
  `scripts/probe-tui-state/tui.ts` (v2 `Plugin.define`), recording session
  store sync, prompt admission id, and `ctx.session.context` counts. It runs
  through the new `--probe-tui-state` harness mode.
- Dropped the v1-only harness probes (`--probe-comms`, `--probe-inject`,
  `--probe-task`) since their endpoints no longer exist; `--demo`,
  `--poke-risk`, `--inspect`, `--tui` stay.
- Verified live against `0.0.0-dev-20288`: `bun run canary --load` OK, harness
  spike OK, TUI state probe OK (store sync + admitted id), 168 tests pass,
  `tsc --noEmit` clean.

### V6 results (2026-09-29)

- `package.json` is v2-only: version `0.2.0`; dependency `@opencode/plugin
  ^2.0.19`; `@opencode-ai/plugin`/`@opencode-ai/sdk`/`@opentui/keymap` removed
  from deps/peers/devDeps (lockfile has no references); peers
  `@opentui/core`/`@opentui/solid` `>=0.5.12` plus `solid-js >=1.9`;
  `engines.opencode: ">=2"`; exports `.`, `./server`, `./tui`; `files` ships
  `server.ts` and `tui.tsx` alongside `src`.
- README rewritten for v2: install via `opencode plugin add` / `plugins`
  entries + `cli.json` for TUI options, the new options table (no
  `keybinds`/`command`/`enabled`; hub pointer note), bash-prefix identity,
  dropped todos/baseline (TUI backfill), prompt-hook comms injection, web view
  guard, v2 development commands (`OPENCODE_BIN`, harness dir outside the
  repo), publishing, and manual verification.
- CI updates: the canary job installs `@opencode/cli@dev`; the pack job also
  asserts `server.ts` and `tui.tsx` are in the tarball.
- Final checks: `bun run typecheck`, `bun test` (168), `bun run canary --load`
  against `0.0.0-dev-20288`, harness spike, and the TUI state probe all pass.
  The branch is committed as a single v2 port commit.

### Test strategy

- Pure logic (hub append/fold/rotate, coord reader/conflicts, redaction, tree,
  command-center, presentation) stays unit-tested; port signatures only.
- Server tests call `setup(ctx)` with a fake v2 context (domains as fakes plus
  an event async iterable and a tool editor recorder) instead of the v1 `Hooks`
  object; keep the existing coverage matrix (identity, coverage risk, leases,
  inbox dedupe, baseline behavior).
- TUI tests fake the v2 `Context` (data stores, keymap, router, dialogs,
  storage, theme) and keep `testRender` layout assertions.
- Add mapping-table tests for the event → `EventRecord` translation, and a probe
  script for anything only provable live (delivery semantics, shell env, durable
  replay).
- Harness stays isolated: random port, XDG state/data/cache, `OPENCODE_CONFIG_DIR`,
  password + Basic auth, kill process group.

### Open questions (remaining)

1. ~~Whether durable events replay to a plugin that subscribes after they were
   published.~~ **Resolved (R2, `2.0.20`): no replay.** A late subscriber
   received no pre-existing session events while a live event in the same
   window arrived; recovery is the hub log plus TUI backfill.
2. ~~Node-hosted CLI plugin loading (precompiled) versus shipping TS source.~~
   **Resolved (R4, `2.0.20`): no Node host exists.** The CLI ships a compiled
   per-platform binary that runs plugins under embedded Bun, so TS source
   exports are retained (Bun-only boundary documented in README).
3. ~~Direct (non-Code-Mode) `session.tool.called` shape and the `task` subagent
   input.~~ **Resolved (R1):** `--probe-task` confirmed a real task child emits
   `session.created` with `parentID` and `agent` and folds as a `subagent` with
   a distinct identity; `--probe-tools` showed the tool event carries no tool
   name and that the model invoked a direct named `swarm_status` entry with no
   `execute` Code Mode wrapper.
4. Sidebar slot ordering/placement after built-ins: the plugin uses `append`
   to `sidebar.content`; `before`/`after`/`prepend` were not compared visually.
5. ~~Which release emits `session.status`/`session.execution.succeeded`.~~
   **Resolved (R1, `2.0.20`):** `session.execution.started/succeeded` fire and
   `session.status`/`session.idle` do not, so status folding correctly keys off
   `session.execution.*` with the host events as a bonus if present.

## Locked decisions

- **API**: v1 server hooks + v1 TUI plugin. `@opencode-ai/plugin` depends on
  `^1.18.32` (lockfile resolved and tested against `1.18.33`, the current
  runtime); the dev-only SDK follows the same range. `@opentui/*` and
  `solid-js` are optional **peer** dependencies so an npm install uses the
  host's renderer and Solid instances, never a duplicate copy. The experimental
  `./v2/effect` API is not used unless a demonstrated need appears.
- **Delivery**: features ship only through the plugin API. Never patch, build,
  or require a local opencode checkout; the package is npm-installable (no
  `private`, `files` whitelists `src`). The dev harness may use a local
  `opencode` binary, but nothing in the plugin runtime may.
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
- **Identity**: in coordination-enabled repos the server plugin always sets
  `COORD_AGENT_ID` via the `shell.env` hook (transient process env only — never
  writes a file), overriding inherited or already populated values. Every
  session gets a distinct `<name>@<host>/<full session id>` and the base is
  cached per repository. Distinct identities per session are required so claims
  and leases never collapse two sessions into one principal
  (`coordination/README.md` convention 3); an earlier root-shared /
  subagent-`sessionID8` scheme was replaced because roots in one directory
  collided. The injected value is recorded as a `session.identity` event so
  readers can join sessions to claims; without injection the mapping falls back
  to heuristics. `coord.injectIdentity` is accepted for compatibility but no
  longer gates injection: lease enforcement and commit-coverage both key on the
  per-session identity, so an off switch would leave shell `coord.py` commands
  unable to match or release the plugin's lease holder.
- **UI order**: sidebar slot first, dashboard route second, toasts/attention
  third.

## Verified surface

- Docs: `https://opencode.ai/docs/plugins/`, `/docs/sdk`, `/docs/config`.
  TUI settings live in `tui.json` (global or project), schema
  `https://opencode.ai/tui.json`.
- Local type files to mirror (opencode 1.18.33): the installed
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
  package.json           # bun; @opencode-ai/plugin ^1.18.32; @opentui/* + solid-js peers (host-provided)
  tsconfig.json
  src/server/index.ts    # event tap -> hub; shell.env identity inject; swarm_status tool
  src/tui/index.tsx      # plugin wiring, sidebar slot, detail route, toasts/attention
  src/tui/dashboard.tsx # command-center list, filters, grouping, search/help
  src/tui/details-pane.tsx # selected task, joined claims/conflicts, transcript preview
  src/tui/dashboard-keys.ts # dashboard keybindings
  src/tui/navigation.ts # host-client session lookup and route switching
  src/tui/presentation.ts src/tui/transcript.ts # shared display/data helpers
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
  aggregate via a shared `storageDir` + `hubGroup`; the web view is implemented
  (see "P6 web view").

## Risks

- Plugin API drift: depend on `^1.18.32` (lockfile at 1.18.33), keep the
  renderer stack as host-provided peers. Resolved for now: `bun run canary`
  checks the host binary against the declared range (`--load` also runs the TUI
  load harness), and `prepublishOnly` gates typecheck + tests.
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
| Real `task` subagent run | done | `--probe-task --model opencode/nemotron-3-ultra-free` starts a scratch server with the server plugin, prompts a model to spawn one subagent, folds the hub, and asserts the recovered `parent`/`agent`/`model` (verified live: child `agent=general`, `model=nemotron-3-ultra-free`); the probe copies auth into the isolated XDG data dir and merges the user's provider block, so no real hub is touched. Manual prompt + `--inspect --expect-subagent` also documented in README |
| Visual TUI + toast/attention behavior | user-run | `--demo` + `--poke-risk` documented in README |
| Harness robustness (random port, stale kill, retry, XDG isolation) | done | baseline spike stable; zombie cause documented |
| Probe: busy-session admission + v1/v2 store split | done | `--probe-comms` (see results) |
| Probe: plugin store coverage for subagents | done | `--probe-tui-state` (see results) |
| P4 viewing implementation | done | `test/tree.test.ts` + `test/transcript.test.ts` pure helpers; cost fold in `test/hub.test.ts`/`test/server.test.ts`; TUI tree/rollups/transcript + `swarm_status format=tree`; `--tui` load; visual check user-run |
| P5 comms implementation | done | `test/comms.test.ts` pure helpers; `swarm_send` + inbox-pull tests in `test/server.test.ts`; injection `--probe-inject`; TUI composer/inbox `--tui` load; visual check user-run |
| Probe: injection part persistence + `comms.delivered` | done | `--probe-inject` (see results) |
| P6 cross-process + portability | partial | state-dir timeout guard + hang test; multi-server fold test; `hubGroup` in server + TUI; CI (`.github/workflows/ci.yml`), `.gitattributes`, LICENSE, `bun.lock`, engines already present; web view implemented (`src/server/web.ts`, `web.enabled`, GET-only, `127.0.0.1`, `test/web.test.ts` + live smoke) |
| Publish prep (npm) | done | `0.1.0`; `private` dropped and `files` whitelists `src`/README/LICENSE; `@opentui/*` + `solid-js` are optional peers with dev deps kept; `@opencode-ai/plugin` `^1.18.32` (lockfile 1.18.33); `prepublishOnly` runs typecheck + tests; `bun run canary` checks the host binary against the range and `--load` runs the TUI harness (8 tests, `test/canary.test.ts`); CI `pack` job asserts the tarball contents and the `canary` job installs the current `opencode-ai`, then runs `canary --load`; local opencode clone restored to upstream |
| P6 review fixes | done | degenerate hub keys -> `unknown`; non-positive timeout guard; globally newest record limit; `EventTail` fresh-comms injection; spike/`--tui`/`--probe-inject` green |
| TUI layout + sidebar affordance | done | rows/panels constrained to full width, conversation clipped; explicit `flexShrink={0}` on labels/rows/panels stops auto-shrink overlap on short terminals (`flexShrink` defaults to 1 for auto dimensions); sidebar is a themed square `scrollbox`, 36 cells wide with the row count derived from the terminal cell aspect (pixel resolution, else `sidebarAspect`, clamped 11–24 rows) so it looks square in pixels rather than cells; last 5 sessions as single-line rows whose titles marquee on hover when they overflow (helpers in `src/tui/presentation.ts`), click-to-open; `test/tui.test.tsx` covers the pixel-square dimensions, aspect/fallback/clamp math, the hover marquee, the 5-session cap, no-wrap rows, theme-token colors, hint, and click-to-open; `test/presentation.test.ts` covers the marquee step/window helpers; `bunfig.toml` preloads the Solid compiler so rendered updates are reactive; sidebar visual check user-confirmed (square + themed + marquee) on 1.18.33 |
| Edit-lease enforcement | done | auto-acquire/refresh via `tools/coord.py lock` for `edit`/`write`/`apply_patch`; `apply_patch` scans add/update/delete plus both sides of a move; denial thrown from `tool.execute.before` outside the monitoring catch; full-session-id identity with a per-repository base cache; `test/leases.test.ts` + `test/lease-enforcement.test.ts` |
| TUI command center (codex-style dashboard) | done | centralized status metadata and bundled task state in `src/tui/command-center.ts` (`test/command-center.test.ts`, 13 tests); separate dashboard, details, keymap, navigation, presentation, and transcript modules; `test/tui.test.tsx` covers layout, the previous-route current-session marker, joined-claim markers/conflict colors, reactive list search, tab/shift-tab, grouping, hierarchy-only expansion, paging/home/end, and help/back; Enter tests execute the production navigator with the generated host SDK, including cached/empty local sessions, host-client 404 fallback, and lookup failure; `/` confirms a list query and Escape clears it; header counts, click selection/filtering, and paging are documented in README; `bun test` (151 passing), `bun run typecheck`, and the installed OpenCode `--tui` load harness verified this refactor |

## P6 review fixes

Four review findings fixed post-P6, one per commit (baseline 80 tests):

| Fix | Change | Evidence |
| --- | --- | --- |
| Degenerate hub keys | `sanitizeProjectID` strips trailing dots/spaces and maps `""`, `.`, `..`, `...` to `unknown`, so `hubGroup` can no longer escape `<storageDir>/subplug/`. | `test/hub.test.ts` sanitize cases |
| Non-positive state-dir timeouts | `stateDirTimeoutMs` ignores `<= 0`/non-finite env values and keeps the 1500 ms default; exported for a direct unit test. | `test/server.test.ts` timeout table |
| Global record limit | `readEventRecords` keeps the globally newest `maxRecords` across all files with a bounded `(ts, seq)` min-heap instead of stopping in lexical file order; `maxRecords: 0` returns `[]`. | `test/hub.test.ts` cross-file limit + tie tests |
| Stale comms fold | `EventTail` seeds byte-offset/identity cursors per hub file before the initial replay and reads only new bytes on `chat.message`; rotation/shrink resets, partial lines are held, `msgID` dedupe makes re-reads idempotent. | `test/hub.test.ts` EventTail tests; `test/server.test.ts` post-bootstrap pointer injection; `--probe-inject` |

## P6 web view

Implemented. `src/server/web.ts` holds the pure request handler
(`createWebFetch`), the `Bun.serve` wrapper (`startWebServer`), and a single
static page (no build step); the status tables moved to `src/shared/status.ts`
so TUI and web share them. The server plugin parses
`web: { enabled, port, token }`, starts the listener in the deferred bootstrap
after `ensure()`, logs the URL through `client.app.log`, and stops it in
`hooks.dispose`. `/api/state` returns the folded `MonitorState` plus per-session
groups; `/api/session/:id` returns a capped transcript via `safeMessages`.
GET-only, `127.0.0.1` only, optional `?token=`. Evidence: `test/web.test.ts`
(page, groups, 405/404, token gate, transcript, bind/shutdown) and a live smoke
run of `opencode serve` with `web.enabled` (page HTTP 200, state JSON with
groups, POST 405, `web view on http://127.0.0.1:7691` logged).

Goal: the command center in a browser for people who prefer a second monitor
over the TUI. Read-only, localhost, opt-in; the hub stays metadata-only.

- **Where it runs**: inside the **server plugin** (it already has the flat
  client and the folded hub; works with or without a TUI window). New option
  `web: { enabled: false, port: 7690, token?: string }`; `enabled: false` by
  default so nothing listens unless asked.
- **Transport**: `Bun.serve` on `127.0.0.1` only. `GET /` serves one static
  HTML+inline-JS page (no build step, no framework); `GET /api/state` returns
  the folded `MonitorState` (already redacted); `GET /api/session/:id` returns
  the transcript via the flat client, capped like the TUI's preview. No
  non-GET methods, no CORS headers.
- **Freshness**: the page polls `/api/state` at `intervalMs` (default 1s) and
  re-renders; the TUI's `readMonitorState` fold is reused verbatim.
- **Auth**: localhost-only by default; optional `token` query param when set.
  Never bind `0.0.0.0`; document the risk if someone does.
- **UI**: status filter tabs and grouping from `src/tui/command-center.ts`
  (pure helpers, reusable) rendered as HTML; claims/conflicts, rollups, inbox
  pointers, and a transcript panel for the selected session. No composer, no
  writes, no attention sounds.
- **Tests**: `Bun.serve` handler as a pure module (request -> response) so
  `bun test` can hit it with a seeded hub; assert GET-only, token gating,
  transcript caps, and no message bodies from the hub.
- **Out of scope**: remote access, multi-project aggregation (use `hubGroup`),
  web comms, websockets/SSE (revisit only if 1s polling proves too slow).

Acceptance: with `web.enabled: true`, `http://127.0.0.1:7690` shows the same
sessions/claims/conflicts as the TUI dashboard, updates within ~1s, and serves
no writes; all existing tests plus the web handler tests pass.

## Edit-lease drill findings (2026-09-28)

The live blocked-edit acceptance was driven headlessly with a persistent
`opencode serve` plus two attached sessions (`deepseek-v4.1-flash`), because a
one-shot `opencode run` exits its server and makes the lease's recorded pid
dead, so a competitor replaces the lease instead of being denied.

- Verified live: identity override with an inherited `COORD_AGENT_ID` (both
  sessions got distinct `<name>@<host>/<full session id>` values), `write` and
  `edit` denial with the exact `is leased by` message, same-holder refresh,
  `unlock` from the holder's own shell identity, and re-acquire after release.
- `apply_patch` is exposed by opencode only to models whose id contains `gpt-`
  (the runtime swaps `edit`/`write` for it), and the available gpt models were
  access-disabled on this machine, so the delete/move denial legs were driven
  through the real `tool.execute.before` hook against the real `coord.py`
  instead of a model call.
- Move support is engine-dependent: the runtime bundle carries one patch engine
  that applies `*** Move to:` moves and another that rejects them ("apply_patch
  moves are not supported yet"); confirm which engine runs `apply_patch` before
  leaning on move gating.
- Identity coherence fix: `shell.env` and commit-coverage now run in every
  coordination-enabled repo regardless of `coord.injectIdentity`, so shell
  `coord.py` commands resolve to the same per-session holder the plugin writes
  into leases.

## Handoff prompt for a fresh window

> Read PLAN.md. P0–P5 are implemented and committed. P5 (session comms) adds
> `src/hub/comms.ts` (fold/inbox/resolveTargets/buildInboxBlock) with unit
> tests; `swarm_send` (`session`/`task_id`, busy-confirm, 5/min cap);
> `swarm_status inbox: true` pull with `comms.seen`; inbox-notice injection in
> `chat.message` (`comms.inject`, in-memory comms fold, dedupe/TTL/byte caps,
> marks `comms.delivered`); and the TUI `m` composer plus the detail Inbox
> panel. Automated gate: `bun install; bun run typecheck; bun test` (125 pass);
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
> short-terminal clipping. Edit-lease enforcement is in: `edit`/`write`/
> `apply_patch` auto-acquire/refresh exact-path leases through the repo's
> `tools/coord.py`, a conflict from another session is thrown from
> `tool.execute.before` (outside the monitoring catch), `apply_patch` scans
> add/update/delete and both sides of a move, and every session now identifies
> as `<name>@<host>/<full session id>` with the base cached per repository.
> Remaining P6: the actual npm publish. The web view is implemented
> (`src/server/web.ts`, `web.enabled`, localhost GET-only); publish prep is
> done: version 0.1.0, `files` whitelist, optional `@opentui/*`/`solid-js`
> peers, `prepublishOnly` gate, `bun run canary` (host range + optional
> `--load` TUI harness), and a CI `pack` job.
> Keep using the flat client for v1 sessions (never the v2 `/api/session`
> store), read transcripts from `api.state.session.messages()`/`part()` when
> the store has content, keep `client.path.get()` out of eager plugin init, and
> keep comms queue-only/addressed with metadata-only hub pointers. Harness
> gotcha: random port, kill stale listeners; a zombie serve answers with stale
> code.

## Current remaining work specification (2026-09-29)

This section supersedes the historical v1 "remaining" and handoff notes for
the current `v7-remote` checkout. The v2 port and V7 feature implementation
are present. V7 execution/LAN acceptance is specified in `V7PLAN.md` under
"Remaining work specification"; its single-machine execution and task-child
runs pass, but the two-device LAN pass is still pending. R0/R1 review fixes and
probe work are committed on `v7-remote`; the suite passes 188 tests and
`bun run typecheck` is clean.

Linux baseline (WSL2/Ubuntu, 2026-09-30, Bun 1.3.3, opencode 2.0.20,
`@opencode/plugin` 2.0.19): `bun install --frozen-lockfile`,
`bun run typecheck`, `bun test` (188 pass), `canary --load`, the local `npm
pack` whitelist, and the harness matrix (spike, `--tui`, `--probe-tui-state`,
`--probe-tui-state --attach`, `--probe-replay`, `--demo --keep`, `--inspect`)
all pass. Two cold-start probe timing races (late-subscriber live delivery and
attach message-store hydration) were hardened by `8e875bf`; no shipped code
changed.

### R1 — live v2 event and subagent contract

Resolve open questions 3 and 5 using the execution-capable V7 probe and one
real task-created child. Record the installed host and plugin versions.

- [x] Capture the event types and relevant field shapes for execution start,
  successful completion, interruption, failure, retry, and task creation.
  Exercise optional/failure paths only where the installed host supports
  them; report unsupported paths explicitly. Evidence (opencode `2.0.20`,
  plugin `0.2.0`, `opencode/nemotron-3.5-lightning-free`): `session.created`
  carries `parentID`+`agent` for a task child (roots omit `parentID`);
  `session.execution.started`/`succeeded`, `session.inbox.enqueued/delivered`,
  `session.step.started/ended`, `session.usage.updated` all fire.
  `session.status` and `session.idle` did **not** fire on this host, so the
  `session.execution.*` fallback in `recordFor` is the working path.
  Interruption/failure/retry were not exercised (optional path; not reported
  as supported).
- [x] Compare emitted records with `recordFor` and the TUI notification
  subscriptions. Verify a successful run ends idle, a failed run does not
  remain busy, and child `parentID`, agent/model when supplied, and distinct
  coordination identity survive folding. Evidence: `--probe-execute` saw busy
  then idle with an assistant transcript; `--probe-task` folded the child as
  `kind: subagent` with `parentID` = root, `agent: general`, `model`, and a
  distinct `Harness Agent@<host>/<sessionID>` identity. No mapping fix was
  needed; the existing `recordFor`/`foldSessions` coverage already matches.
  A failed run was not exercised.
- [x] Verify both direct tools and Code Mode where available; document which
  path ran. Restore a bounded v2 `--probe-task` only if automation is useful;
  do not reuse the removed v1 HTTP endpoints. `--probe-task` is restored as an
  opt-in mode that prompts the root to create one real `task` subagent and
  checks the folded parent link. `--probe-tools` asks the model to call
  `swarm_status` once. Observed on `2.0.20`: the assistant content records a
  direct `swarm_status` tool entry — no `execute` Code Mode wrapper entry — and
  `session.tool.called`/`failed`/`success` events carry no tool name
  (`assistantMessageID`, `executed`, `id`, `input`, and `error` on failure), so
  the routing is read from the message, not the event. The scratch call errored,
  which does not affect the routing observation.

Acceptance: redacted event-shape evidence, a correct folded root/child state,
and regression tests for any mapping fix. Avoid committing full transcripts
or credentials. Reuse the V7 run where it supplies the same evidence.
Met on opencode `2.0.20` (Windows, 2026-09-29); tool routing is recorded above
as a direct named tool with no Code Mode wrapper observed.

### R2 — durable replay and recovery contract

Resolve open question 1 without assuming that subscribing replays history.

- [x] In an isolated workspace, create a root/child and emit events before
  loading a probe subscriber. Compare what the late subscriber receives with
  what a subscriber established before the run receives. `--probe-replay`
  (fresh `SUBPLUG_HARNESS_DIR`) published two sessions, then attached a late
  subscriber: no pre-existing events arrived, while a live session created
  during the same window did. The TUI store also started cold (`sessionCount`
  0 for pre-existing sessions) until backfill runs.
- [x] Restart with the existing hub, then with an empty hub. Check server
  tool visibility separately from TUI backfill, including parent links and
  status. Identify which metadata is durable and which must be read live. The
  restart leg retained the hub JSONL (7 records, 3 `session.created`) and
  re-registered the tools (`features.server: true`, `state: active`) against
  the existing hub. The empty-hub path is the ordinary cold start; the
  activation-window gap is closed by TUI backfill. Status/cost/messages are
  live reads, not hub state.
- [x] Document the observed recovery guarantee. If acceptance requires more
  recovery than the host provides, specify and implement a bounded native
  session import through verified v2 APIs; do not rely on replay accidentally
  observed in one development build. The guarantee is documented in README
  under "Recovery contract". No new import was added: the existing TUI
  backfill (`client.session.list()` → missing `session.created` records)
  already covers the only recovery the host cannot do server-side, and the
  server context still has no session-listing API.

Acceptance: a reproducible restart matrix and an explicit recovery contract
in README. Any added import has limits, no duplicate records, and tests for
missing/deleted sessions and failing native lookups.
Met on opencode `2.0.20` (Windows, 2026-09-29): `--probe-replay` is the
reproducible matrix; `test/tui-data.test.ts` covers malformed rows, known and
deleted sessions (no duplicates, no resurrection), an empty native list, and a
failing native lookup. No import was added, so no new import limits apply.

### R3 — visual v2 acceptance

Resolve open question 4 and the outstanding visual checks on the current
v2 host, rather than relying on the historical v1 screenshots.

- [ ] Use `--demo --keep` and README's visual checklist to verify sidebar
  placement, task selection, tabs/search/grouping, hierarchy expansion,
  detail navigation/back, scrolling, claims/conflicts, and follow-up dialogs.
- [ ] Check normal and narrow terminals, including a short terminal; controls
  and selected rows must remain usable without text overlap.
- [ ] Compare slot placement options only if the current appended sidebar
  is obstructed or confusing; retain the current placement when it passes.
- [ ] Verify risk/error/completion toast and attention behavior against live
  events; synthetic demo evidence alone does not prove host event delivery.

Acceptance: dated screenshots or a short recording and a concise checklist
with host version and terminal dimensions. Report platform-specific issues.
The remote variants are covered by V7.R2 rather than a duplicate run.

### R4 — Node-host compatibility decision

Open question 2 is a compatibility investigation, not an automatic build-system
change. The package currently ships TypeScript source for the verified host.

- [x] Identify a supported Node-hosted v2 distribution before adding it to the
  compatibility matrix. Install the packed artifact into that host and check
  server/TUI entrypoints, cleanup, and optional renderer peers. None exists:
  `@opencode/cli@2.0.20` declares `bin.opencode`/`bin.opencode2` as
  `./bin/opencode.exe` (a ~206 MB compiled binary) with per-platform
  `@opencode/cli-<os>-<arch>` optional dependencies; `postinstall.mjs` only
  selects the platform binary. The host runs plugins under its embedded Bun
  runtime, so there is no Node host to install into.
- [x] If that supported host cannot load the source, specify a compiled export
  strategy and test the packed artifact against both distributions. Otherwise
  retain source exports and document the verified runtime. Retained: source
  exports, no compilation pipeline. `bun pm pack --dry-run` packs 35 files
  including `server.ts`, `tui.tsx`, and `src/**` (TS source, no build output);
  README documents the Bun-only boundary. The web view's `typeof Bun ===
  "undefined"` guard (`src/server/web.ts:82`) already returns its clear
  unavailable message.

Acceptance: either evidence for supported Node loading or a documented Bun-only
support boundary. The optional web view must give its existing clear unavailable
message where `Bun.serve` is absent. Do not add a compilation pipeline merely to
close a speculative question.
Met on opencode `2.0.20` (Windows, 2026-09-29): Bun-only boundary documented in
README; no pipeline added; the web guard is unchanged and still covered by
`test/web.test.ts`.

### R5 — documentation reconciliation and release

- [x] Add a current-status summary pointing to these checklists and V7's
  acceptance evidence. Preserve v1 history but label it clearly; remove stale
  instructions from the active handoff. Update the test count after changes.
  Added to the top v2 status section; suite is 188 tests. v1 sections remain
  under their historical headings.
- [x] Verify supported opencode versions against the live evidence; adjust
  declared ranges only when compatibility results justify it. Validated on
  `@opencode/cli` 2.0.20 with `@opencode/plugin` 2.0.19; `engines.opencode`
  `>=2` and the declared `^2.0.19` line still hold, so the ranges are
  unchanged.
- [x] Run typecheck, the full suite, `canary --load`, and the harness server
  spike against the intended release host. Verify Windows and Linux CI.
  Windows (2026-09-29, `2.0.20`): typecheck clean, 188 pass, `canary --load`
  OK (TUI loaded, version 0.3.0), harness spike OK. Linux (WSL2/Ubuntu,
  2026-09-30, `2.0.20`, Bun 1.3.3): the same gates plus the local `npm pack`
  whitelist and the full harness matrix pass, so the `ci.yml`
  `test`/`canary`/`pack` jobs were reproduced locally instead of left to CI.
- [x] Pack the package and install that tarball in isolated server/TUI config;
  confirm both entrypoints, optional peers, and the documented options work.
  Inspect tarball contents using the existing CI whitelist. `bun pm pack` →
  `subplug-0.3.0.tgz` (60 KB, 35 files); extracted, `bun install`ed its
  declared deps, and loaded that copy through `SUBPLUG_HARNESS_PLUGIN`: server
  spike OK (`features.server`, identity via the `coord`/`storageDir` options)
  and `--tui` OK (route `subplug`, version 0.3.0). Contents match `ci.yml`'s
  whitelist (`server.ts`, `tui.tsx`, `src/**`, README, LICENSE, package.json;
  no `test/` or `scripts/`).
- [x] Choose the release version, write concise release notes, and record the
  validated host version. Review/commit the fixes and acceptance evidence,
  then integrate the branch through the project's normal review process.
  Chose `0.3.0` (minor: remote attach); notes in `CHANGELOG.md`; validated
  host `@opencode/cli` 2.0.20. Committed on `v7-remote`; branch integration
  stays a separate review/merge decision.
- [ ] Publish only after an explicit release decision; verify the published
  artifact with the same isolated install smoke check. **Pending an explicit
  decision**; the packed-artifact smoke above is the check to repeat after
  publish.

Acceptance: the release artifact loads successfully and all required gates
pass. Failed gates block release; missing external prerequisites stay pending.
No additional broad feature development is implied by this checklist.
Met on Windows (`2.0.20`, 2026-09-29): every gate passes and the packed artifact
loads both entries. The publish step and the Linux CI run remain pending
(external decisions/environments).

### Execution order

1. ~~Finish V7.R0 regression coverage and V7.R1 probe work.~~ Done.
2. ~~Run R1/R2 locally with a configured model; run R3 visual checks.~~
   R1/R2 done; R3 visual checks still need an interactive terminal.
3. Run V7.R2 on two devices, sharing event/subagent evidence with R1.
4. ~~Resolve R4's support boundary and complete R5 release preparation.~~
   R4 done; R5 done except publish.
5. Make the separate integration/publish decision when evidence is ready.
