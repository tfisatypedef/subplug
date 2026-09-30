# Contributing

Thanks for working on subplug. This file collects the development, testing, and
release workflows so the [README](README.md) can stay focused on installing and
using the plugin.

## Setup

Requirements: [Bun](https://bun.sh) `>= 1.3` and opencode v2 (from
`@opencode/cli`; installed as `opencode`, with a legacy `opencode2` alias for
the same binary).

```sh
bun install
bun run typecheck
bun test
```

Runtime boundary (Node): there is no Node-hosted opencode v2 distribution to
target. `@opencode/cli@2.0.20` ships per-platform compiled binaries
(`bin/opencode.exe`, with `@opencode/cli-<platform>` optional dependencies) and
the host loads plugins with its embedded Bun runtime, so subplug ships
TypeScript source and needs no build step. The optional web view keeps a clear
"unavailable" message when `Bun.serve` is absent, so a non-Bun host degrades
instead of failing. Nightly `0.0.0-dev-*` builds are accepted by the canary.

## Installing from a clone

opencode discovers both entrypoints from `package.json` `exports["./server"]`
and `exports["./tui"]`, or from `server.ts` / `tui.tsx` when the package is a
local directory. A package listed in `opencode.json` that exposes `./tui` loads
its TUI component automatically, so one entry installs the server and TUI
plugins together. Use `cli.json` only for CLI-only plugins, or for TUI-only
options that do not reach the auto-loaded component.

```sh
git clone https://github.com/tfisatypedef/subplug.git ~/src/subplug
cd ~/src/subplug && bun install          # runtime + test deps
```

Then add the clone as a local plugin directory. Local specs must be directories;
the host loads `server.ts` and `tui.tsx` from the root. In `opencode.json` in
the config directory (global `OPENCODE_CONFIG_DIR` or a project's `.opencode/`):

```json
{
  "plugins": [{ "package": "/home/you/src/subplug", "options": { "storageDir": "/tmp/subplug-hub" } }]
}
```

An explicit `storageDir` here reaches the server; the TUI reads the hub pointer
the server writes. To update, `cd /home/you/src/subplug && git pull && bun install`
and restart opencode.

## Canary

Run the canary against a v2 host to check that the plugin contract still holds:

```sh
OPENCODE_BIN=/path/to/opencode bun run canary               # host is v2 + matching @opencode/plugin
OPENCODE_BIN=/path/to/opencode bun run canary --load        # canary plus the headless TUI load harness
```

## Dev harness

The harness resolves the host from `OPENCODE_BIN`, then `opencode2`, then
`opencode`, so a v1 `opencode` on `PATH` does not shadow the v2 build. Each run
uses a random port and an isolated XDG tree under
`${SUBPLUG_HARNESS_DIR:-$TMPDIR/subplug-harness}`, so it never touches your real
opencode state. `--keep` leaves the scratch dir behind.
`SUBPLUG_HARNESS_PLUGIN=<dir>` loads that plugin directory instead of the repo,
which is how the packed artifact is smoke-tested. The workspace lives outside
the repo on purpose: opencode watches local plugin sources, so state writes
inside the repo would retrigger plugin reloads.

```sh
bun run scripts/dev-harness.ts                               # headless server spike (scratch config + repo)
bun run scripts/dev-harness.ts --tui                         # headless TUI load check (marker file)
bun run scripts/dev-harness.ts --probe-tui-state             # plugin store + session.context coverage
SUBPLUG_PROBE_MODEL=provider/model bun run scripts/dev-harness.ts \
  --probe-tui-state --attach --probe-execute  # one bounded scratch prompt
SUBPLUG_PROBE_MODEL=provider/model bun run scripts/dev-harness.ts \
  --probe-tui-state --attach --probe-task     # one task-created child, folded parent check
SUBPLUG_PROBE_MODEL=provider/model bun run scripts/dev-harness.ts \
  --probe-tui-state --attach --probe-tools    # ask for one tool call, record its routing
SUBPLUG_HARNESS_DIR=$TMPDIR/subplug-replay bun run scripts/dev-harness.ts \
  --probe-tui-state --probe-replay            # late-subscriber replay + restart durability
SUBPLUG_PROBE_SERVER_URL=http://<server-ip>:4096 OPENCODE_PASSWORD=<password> \
  SUBPLUG_PROBE_MODEL=provider/model bun run scripts/dev-harness.ts \
  --probe-tui-state --existing-server --probe-execute
bun run scripts/dev-harness.ts --demo --keep                 # seed a hub and print TUI launch instructions
```

`--probe-execute` requires `SUBPLUG_PROBE_MODEL=provider/model` and records
prompt admission, execution events, store status transitions, transcript
appearance, and cost in a redacted JSON result. `SUBPLUG_PROBE_TIMEOUT_MS`
bounds the wait (default 90 seconds). `--existing-server` connects to an
already running server, writes only to a fresh client scratch directory, and
retains the result path it prints. It creates two named sessions and admits one
scratch prompt on that server; execution mode also runs the selected model. It
never seeds server workspace files or stops the server. Run that mode on a
second device for the two-device acceptance checklist below; the same-machine
`--attach` run is an earlier gate.

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

## Two-device acceptance (LAN or Tailscale)

The V7.R2 checklist in `V7PLAN.md` needs two machines: a server with a
configured model, and a client that attaches. The server can be reached over
the LAN or an encrypted overlay — `<server-ip>` below is either (see the
README's Remote attach section). With a WSL2 client, run the server on the
second device so the client connects outbound (WSL2's NAT does not accept
inbound LAN connections without host port forwarding).

### Server device setup

The probe requires subplug to be **active on the server**, not just the client
(`--existing-server` reads `/api/plugin` and fails if the server entry is
missing). The plugin loader accepts a directory, so install from a clone (the
repo is public). Use `-b v7-remote` — the default branch is the v1 plugin:

```sh
npm install -g @opencode/cli          # verified 2.0.20
git clone -b v7-remote https://github.com/tfisatypedef/subplug.git ~/subplug
(cd ~/subplug && bun install)         # or npm install
mkdir -p ~/subplug-server
cat > ~/subplug-server/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/home/<user>/subplug" }]
}
JSON
```

For a clean evidence trail, pin both sides to the same commit before the run
(`git -C ~/subplug rev-parse HEAD` should match `git rev-parse HEAD` here);
otherwise re-pull both. To verify the exact npm artifact instead of a checkout,
`npm pack`, extract `subplug-0.3.0.tgz`, `npm install` inside it, and point
`package` at that directory.

`bun install` is required before the plugin can load: the entries import
`@opencode/plugin` (and the TUI entry `@opencode/plugin/tui`) at runtime, not
just for types, so the package must be resolvable from the checkout.

Configure a model/provider on the server (e.g. `opencode auth login`), then
start it. Bind the interface the client will reach and allow inbound TCP 4096
through the host firewall. Over Tailscale, replace `--hostname 0.0.0.0` with
`--hostname "$(tailscale ip -4)"` to keep the port off the LAN:

```sh
OPENCODE_PASSWORD=<password> OPENCODE_CONFIG_DIR=~/subplug-server \
  opencode serve --hostname 0.0.0.0 --port 4096
```

Confirm the endpoint from the client before probing (`<server-ip>` is the
server's LAN or overlay address; see the README's Remote attach section —
loopback only works on the same machine):

```sh
curl -u "opencode:<password>" http://<server-ip>:4096/api/info
```

### Client device setup

subplug's TUI entry runs on the client and cannot be fetched across the
network, so the client needs its own copy at the same commit:

```sh
npm install -g @opencode/cli          # or set OPENCODE_BIN for the probe
git clone -b v7-remote https://github.com/tfisatypedef/subplug.git ~/subplug
git -C ~/subplug checkout <commit>    # match `git -C ~/subplug rev-parse HEAD` on the server
(cd ~/subplug && bun install)         # runtime deps: @opencode/plugin, @opentui/*, solid-js
```

The probe resolves the host from `OPENCODE_BIN`, then `opencode2`, then
`opencode`. For the visible pass, load the TUI entry from the client's
`cli.json` and launch against the server. The client has no local server, so
this is the CLI-only path that stays active against the attached remote:

```sh
cat > <client-config-dir>/cli.json <<'JSON'
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{ "package": "/home/<user>/subplug" }]
}
JSON
OPENCODE_CONFIG_DIR=<client-config-dir> OPENCODE_PASSWORD=<password> \
  opencode --server http://<server-ip>:4096
```

On the client, run the probe against that server twice (execution, then a real
task child). `SUBPLUG_PROBE_MODEL` names a model configured on the **server**,
because v2 executes server-side:

```sh
SUBPLUG_PROBE_SERVER_URL=http://<server-ip>:4096 \
OPENCODE_PASSWORD=<password> \
SUBPLUG_PROBE_MODEL=<provider/model> \
  bun run scripts/dev-harness.ts --probe-tui-state --existing-server --probe-execute

SUBPLUG_PROBE_SERVER_URL=http://<server-ip>:4096 \
OPENCODE_PASSWORD=<password> \
SUBPLUG_PROBE_MODEL=<provider/model> \
  bun run scripts/dev-harness.ts --probe-tui-state --existing-server --probe-task
```

Each run prints its redacted JSON result path; keep it plus a manual record of
device OSes, versions, polling interval, outcomes, and limitations. In the
report, `remote` must be `true`, the store must hydrate, and the bounded
`events[].at` vs `statuses[].at` timestamps (one client clock) show the busy
and idle transitions. `--existing-server` writes only to a fresh client scratch
directory and never touches the server workspace or a local hub. The probe
covers the state and latency items; the V7.R2 UI items (dashboard/sidebar
"claims unavailable", transcript navigation, follow-up confirm/queue, toasts,
disconnect/reconnect) still need the visual pass.

## Publishing

`prepublishOnly` runs `typecheck` + `test`, so a broken tree cannot ship.
Before publishing, run `bun run canary --load` against the v2 host, bump
`version` in `package.json`, then `npm publish` (the `files` whitelist ships
`server.ts`, `tui.tsx`, `src`, `README.md`, and `LICENSE`). CI verifies the
tarball in the `pack` job and runs `canary --load` against `@opencode/cli@dev`
in the `canary` job.

Validated release: `0.3.0` against `@opencode/cli` 2.0.20 / `@opencode/plugin`
2.0.19 (Windows 2026-09-29; Linux WSL2/Ubuntu, Bun 1.3.3, 2026-09-30). To
smoke-test a packed artifact locally, extract the tarball, `bun install` its
declared deps, and point the harness at it with
`SUBPLUG_HARNESS_PLUGIN=<extracted-package-dir>` for the spike and `--tui`.

## Manual verification

### Visual TUI check

```sh
bun run scripts/dev-harness.ts --demo --keep
# follow the printed launch instructions, e.g.:
export OPENCODE_CONFIG_DIR="$TMPDIR/subplug-harness/config"
opencode "$TMPDIR/subplug-harness/repo"
```

`--demo` seeds a root session (busy), a subagent (idle), a joined claim, a
conflict, and a stale risk. In the TUI:

- the sidebar **Agents** slot lists both sessions and the active-claim count;
- `/subplug` opens the command center: filter tabs with counts, `g` cycles
  grouping (Project → Status → Agent → Hierarchy), Project nests the subagent
  under its parent with collapse via `←`/`→` and `b` breaks it back out into a
  flat list, a per-selection details pane with
  subtree rollup, joined claims (`⇄ <session>`), and conflict coloring;
- Enter opens the detail view for a session this instance does not own (as in
  the demo): breadcrumb, rolled-up subtree cost/counts, a pending **Inbox**
  (seeded by `--demo`), and a live transcript that updates while the demo
  subagent runs; `m` opens the composer, which confirms first when the target
  is busy;
- in a second terminal run `bun run scripts/dev-harness.ts --poke-risk` to
  append a live risk and confirm the warning toast + attention sound.

### Real `task` subagent check

With the TUI (or `opencode`) open in the demo repo, prompt:

> Spawn exactly one subagent with the task tool. Ask it to run
> `node -p "process.env.COORD_AGENT_ID"` through its bash tool and report the
> output.

The identity arrives as the `export COORD_AGENT_ID='...'` prefix on `bash`
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

## Recovery contract (detail)

The event stream is live-only: a plugin that subscribes after an event was
published does not receive it (verified on opencode `2.0.20`, plugin `0.2.0`: a
late subscriber got no pre-existing session events while a live event during the
same window arrived), so history is never replayed. The TUI store is likewise
cold at boot for sessions it did not sync.

The v2 server context has no session-listing API, so sessions created while no
subscriber was attached are recovered only through the TUI backfill: the TUI
enumerates native sessions and writes the ones the hub does not already know
(including ids recorded as `session.deleted`) into the hub. Live session state —
status, cost, messages — is always read through `ctx.data`/`ctx.client`; the hub
holds only appended metadata.

Edit leases live in the per-worktree git directory, never in git. `apply_patch`
checks every add/update/delete path plus both sides of a move, and a lease
denial is thrown from the tool hook (not swallowed by the monitoring catch).
Shell commands that mutate files are not gated. To aggregate different clones,
point them at the same `storageDir` and set the same `hubGroup`.

## Remote attach (detail)

`<server-ip>` is the server's LAN address (`ip -4 addr` on Linux, where
`hostname -I` is not portable; `ipconfig getifaddr en0` on macOS; `ipconfig` on
Windows) or, off-LAN, an encrypted overlay address. Loopback (`127.0.0.1`) only
reaches a server on the same machine. An overlay normally handles the firewall
itself; `sudo ufw allow in on tailscale0 to any port 4096 proto tcp` is the fix
if it does not.

Off-LAN clients work over an encrypted overlay such as Tailscale: use the
server's `100.x.y.z` address (`tailscale ip -4`) or MagicDNS name in place of
`<server-ip>`. The overlay is already encrypted, so the plain-HTTP Basic
credentials are not exposed in transit. With a WSL2 client, either enable
mirrored networking (`[wsl2]` `networkingMode=mirrored` in
`%UserProfile%\.wslconfig`, then `wsl --shutdown`) so WSL shares the host's
overlay interface, or install Tailscale inside WSL. A native client on the same
LAN needs no overlay — it connects outbound to the server's LAN address as-is.

Prefer the overlay address directly. If you front the server with
`tailscale serve`, bind it to `0.0.0.0` rather than `127.0.0.1`: a loopback bind
advertises `http://127.0.0.1:<port>` in `/api/info`, which every client matches
against its own loopback and classifies as local, so auto-detection skips the
hub-free remote path. If you must bind loopback, force the mode with the
`remote` option. Auto-detection compares the advertised `urls` against local
interfaces, with the session directory as a fallback.
