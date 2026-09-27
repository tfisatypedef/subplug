# subplug — plan

An opencode plugin that lets a session monitor the other sessions and subagents
working on a project, overlaid with the `coordination/` claim registry.

Status: **P0 complete; P1/P2/P3 core implemented and load-verified**. Server tap,
session fold, coord bridge, `swarm_status` tool, `shell.env` identity injection,
and the TUI sidebar/route/toasts are in place. Remaining: live `task`-subagent
observation and visual TUI checks (see "Implementation status").

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
- **Mode**: read-only monitoring. No abort/steer/control in v1.
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
  src/hub/               # store paths, append, rotation, fold, monitor merge
  src/coord/             # claims reader/fold/conflicts, glob, repo discovery
  src/shared/            # normalized records, redaction
  scripts/dev-harness.ts # scratch config + seeded repo; headless server + TUI checks
  test/                  # bun test: coord, hub, redact
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
- **P4+ — cross-process.** Aggregate multiple clones/windows; optional web view.

## Risks

- Plugin API drift: pin 1.18.32 and add a canary check.
- TUI slot/API stability; attention sounds are new surface.
- SolidJS (`@opentui/solid`) renderer is unfamiliar territory vs React.
- `shell.env` `sessionID` is optional (`index.d.ts:242-248`); identity injection
  must not collapse two sessions onto one identity when it is absent.
- Privacy defaults and storage retention.
- Windows path/EOL parity.
- Mapping quality when `COORD_AGENT_ID` is absent.

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
| TUI sidebar/route/risk toast (SolidJS) | load-verified | TUI marker from `--tui`; `--demo` seed for visual check |
| Real `task` subagent run | user-run | prompt + `--inspect` documented in README |
| Visual TUI + toast/attention behavior | user-run | `--demo` + `--poke-risk` documented in README |

## Handoff prompt for a fresh window

> Read PLAN.md. P0 and the P1/P2/P3 implementation are complete, including
> unique subagent identities, the claim↔session join, and the commit coverage
> risk toast. Automated gate: `bun install; bun run typecheck; bun test;
> bun run scripts/dev-harness.ts; bun run scripts/dev-harness.ts --tui`. The
> user then runs the manual checks from the README: `--demo --keep` + `opencode`
> for the visual TUI, `--poke-risk` for the toast, and a real `task` prompt +
> `--inspect` for live parent/child records. Next phase after that is
> portability/packaging (own GitHub repo, LICENSE, `bun.lock`, `.gitattributes`,
> dual-platform README, engines, CI, `resolveStateDir` retry/fallback fix). Keep
> `client.path.get()` out of eager plugin init.
