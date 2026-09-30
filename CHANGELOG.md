# Changelog

## 0.3.0

Remote attach for opencode v2: monitor sessions running on another machine on
the LAN as if working locally.

- Auto-detect a remote attach from the attached server's advertised URLs, with
  `remote: "auto" | "remote" | "local"` (and `SUBPLUG_REMOTE`) overrides.
- Remote attaches render from live `data.session`/`client` state and are
  hub-free: claims, conflicts, risk toasts, and command history report
  "claims unavailable on remote" instead of mixing with a local hub.
- Remote dashboards enumerate sessions through the attached server's session
  list (the reactive store is the fallback), so pre-existing server sessions
  appear; previously only sessions learned about after attaching were shown.
- Project grouping nests each subagent under its parent and collapses with
  `←`/`→`; `b` breaks subagents back out into a flat list.
- Remote transcripts read from the store with `session.context` as fallback;
  follow-ups route through the attach. A failed status lookup stays `unknown`,
  so sending requires confirmation.
- Docs: README "Remote attach" and "Recovery contract"; dev-harness probe
  modes `--probe-execute`, `--probe-task`, `--probe-replay`, and
  `--existing-server`.
- Verified against `@opencode/cli` 2.0.20 (`opencode2`) with
  `@opencode/plugin` 2.0.19.

## 0.2.0

v2 port: server + TUI entries on `@opencode/plugin` ^2.0.19 (`Plugin.define`),
live event tap, `swarm_status`/`swarm_send`, prompt-hook comms injection,
store-backed transcripts, and the read-only localhost web view.
