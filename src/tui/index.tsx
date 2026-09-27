/** @jsxImportSource @opentui/solid */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { KeyEvent, RGBA, Renderable } from "@opentui/core"
import { createBindingLookup, type BindingConfig } from "@opentui/keymap/extras"
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { ClaimRecord, MonitorState, SessionNode } from "../shared/types.ts"
import { joinClaimsToSessions, readMonitorState } from "../hub/monitor.ts"
import { hubRoot } from "../hub/paths.ts"
import { findRepoRoot } from "../coord/repo.ts"

type Cfg = {
  route: string
  command: string
  keybinds: BindingConfig<Renderable, KeyEvent> | undefined
  intervalMs: number
  storageDir: string | undefined
}

type Skin = {
  panel: RGBA | string
  border: RGBA | string
  text: RGBA | string
  muted: RGBA | string
  accent: RGBA | string
  error: RGBA | string
  warning: RGBA | string
  success: RGBA | string
}

const defaultKeymap: BindingConfig<Renderable, KeyEvent> = {
  "subplug.open": "ctrl+alt+a",
}

function pick(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function config(options: Record<string, unknown> | undefined): Cfg {
  const coord = record(options?.coord) ? options.coord : undefined
  return {
    route: pick(options?.route, "subplug"),
    command: pick(options?.command, "subplug.open"),
    keybinds: record(options?.keybinds) ? (options.keybinds as BindingConfig<Renderable, KeyEvent>) : undefined,
    intervalMs: Math.max(250, num(options?.intervalMs, 1000)),
    storageDir: pick(options?.storageDir, "") || pick(coord?.storageDir, "") || process.env.SUBPLUG_STORAGE_DIR || undefined,
  }
}

function emptyState(): MonitorState {
  const now = Date.now()
  return {
    generatedAt: now,
    hubDir: "",
    sessions: [],
    risks: [],
    registry: { claims: [], verifications: [], conflicts: [], errors: [] },
  }
}

function skinOf(api: TuiPluginApi): Skin {
  const theme = api.theme.current
  return {
    panel: theme.backgroundPanel,
    border: theme.border,
    text: theme.text,
    muted: theme.textMuted,
    accent: theme.primary,
    error: theme.error,
    warning: theme.warning,
    success: theme.success,
  }
}

function age(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function statusMark(status: SessionNode["status"]): string {
  if (status === "busy") return "●"
  if (status === "retry") return "◌"
  if (status === "error") return "✖"
  if (status === "idle") return "○"
  return "·"
}

function statusColor(skin: Skin, status: SessionNode["status"]): RGBA | string {
  if (status === "error") return skin.error
  if (status === "busy") return skin.success
  if (status === "retry") return skin.warning
  return skin.muted
}

function sessionLabel(session: SessionNode): string {
  const name = session.title?.trim() || session.sessionID.slice(0, 12)
  return name.length > 42 ? `${name.slice(0, 41)}…` : name
}

function claimLabel(claim: ClaimRecord, now: number): string {
  const expiry = Date.parse(claim.expires)
  const remaining = Number.isNaN(expiry) ? "?" : age(now, expiry)
  const baton = claim.scopes.baton ? ` ⚑${claim.scopes.baton}` : ""
  return `${claim.agent} ${remaining}${baton}`
}

function createMonitor(api: TuiPluginApi, cfg: Cfg) {
  const [state, setState] = createSignal<MonitorState>(emptyState())
  let hubDir: string | undefined
  let repoRoot: string | undefined
  let resolved = false
  let lastRiskAt = Date.now()

  const resolvePaths = async () => {
    if (resolved) return
    resolved = true
    let projectID = "unknown"
    try {
      const response = (await api.client.project.current()) as unknown as {
        data?: { id?: string }
        id?: string
      }
      projectID = response?.data?.id ?? response?.id ?? "unknown"
    } catch {
      // keep the placeholder project id
    }
    hubDir = hubRoot(cfg.storageDir ?? api.state.path.state, projectID)
    repoRoot = findRepoRoot(api.state.path.worktree)
  }

  const tick = async () => {
    try {
      await resolvePaths()
      if (!hubDir) return
      const next = readMonitorState(hubDir, repoRoot)
      setState(next)
      const latest = next.risks.at(-1)
      if (latest && latest.ts > lastRiskAt) {
        lastRiskAt = latest.ts
        api.ui.toast({
          variant: "warning",
          title: "subplug: claim coverage",
          message: latest.summary,
          duration: 6000,
        })
        void api.attention.notify({
          title: "subplug",
          message: latest.summary,
          sound: { name: "error" },
        })
      }
    } catch {
      // monitoring must never crash the TUI
    }
  }

  void tick()
  const timer = setInterval(() => {
    void tick()
  }, cfg.intervalMs)
  api.lifecycle.onDispose(() => clearInterval(timer))

  return state
}

function Sidebar(props: { state: () => MonitorState; sessionID: string }) {
  const snapshot = () => props.state()
  return (
    <box
      border
      borderColor={"#4a4a4a"}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
      gap={1}
    >
      <text fg={"#5f87ff"}>
        <b>Agents</b>
        <span style={{ fg: "#a5a5a5" }}> subplug</span>
      </text>
      {snapshot().sessions.length === 0 ? <text fg={"#a5a5a5"}>no sessions seen yet</text> : null}
      {snapshot()
        .sessions.slice(-5)
        .map((session) => (
          <text fg={session.sessionID === props.sessionID ? "#f0f0f0" : "#a5a5a5"}>
            {statusMark(session.status)} {session.kind === "subagent" ? "└ " : ""}
            {sessionLabel(session)}
          </text>
        ))}
      <text fg={"#a5a5a5"}>
        claims {snapshot().registry.claims.filter((claim) => claim.status === "active").length} active
        {snapshot().registry.conflicts.length > 0
          ? ` · ${snapshot().registry.conflicts.length} conflict${snapshot().registry.conflicts.length === 1 ? "" : "s"}`
          : ""}
      </text>
    </box>
  )
}

function Dashboard(props: { api: TuiPluginApi; state: () => MonitorState; route: string; command: string }) {
  const snapshot = () => props.state()
  const skin = () => skinOf(props.api)
  const now = () => snapshot().generatedAt
  const holders = () => joinClaimsToSessions(snapshot().registry, snapshot().sessions)

  return (
    <box width="100%" height="100%" backgroundColor={skin().panel} flexDirection="column">
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={skin().text}>
            <b>subplug</b>
            <span style={{ fg: skin().muted }}> swarm dashboard</span>
          </text>
          <text fg={skin().muted}>updated {age(snapshot().generatedAt, Date.now())} ago</text>
        </box>
        <text fg={skin().muted}>hub {snapshot().hubDir || "(resolving)"}</text>

        <box
          border
          borderColor={skin().border}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
          flexGrow={1}
        >
          <text fg={skin().accent}>
            <b>Sessions ({snapshot().sessions.length})</b>
          </text>
          {snapshot().sessions.length === 0 ? <text fg={skin().muted}>no sessions recorded yet</text> : null}
          {snapshot().sessions.map((session) => (
            <box flexDirection="column">
              <text fg={statusColor(skin(), session.status)}>
                {statusMark(session.status)} {session.kind === "subagent" ? "└ " : ""}
                <span style={{ fg: skin().text }}>{sessionLabel(session)}</span>
                <span style={{ fg: skin().muted }}>
                  {" "}
                  {session.sessionID.slice(0, 12)} {session.status} {age(session.lastEventAt, now())} ago
                  {session.agent ? ` agent=${session.agent}` : ""}
                  {session.model ? ` model=${session.model}` : ""}
                </span>
              </text>
            </box>
          ))}
        </box>

        <box
          border
          borderColor={skin().border}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
          flexGrow={1}
        >
          <text fg={skin().accent}>
            <b>Claims ({holders().length} active)</b>
          </text>
          {holders().length === 0 ? <text fg={skin().muted}>no active claims</text> : null}
          {holders().map(({ claim, session }) => (
            <text fg={skin().text}>
              <span style={{ fg: skin().muted }}>{claim.claimID.slice(-10)}</span> {claimLabel(claim, now())}
              {session ? (
                <span style={{ fg: skin().success }}> ⇄ {session.sessionID.slice(0, 10)}</span>
              ) : (
                <span style={{ fg: skin().muted }}> (no session)</span>
              )}
              {claim.note ? <span style={{ fg: skin().muted }}> {claim.note.slice(0, 60)}</span> : null}
            </text>
          ))}
          {snapshot().registry.conflicts.map((conflict) => (
            <text fg={skin().error}>
              conflict {conflict.a.slice(-10)} / {conflict.b.slice(-10)}: {conflict.reason}
            </text>
          ))}
          {snapshot().registry.errors.length > 0 ? (
            <text fg={skin().warning}>registry errors: {snapshot().registry.errors.length}</text>
          ) : null}
        </box>

        <text fg={skin().muted}>/{props.route} to open · {props.command} opens from the command palette</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return

  const cfg = config(options)
  const state = createMonitor(api, cfg)

  try {
    const markerDir = join(cfg.storageDir ?? api.state.path.state, "subplug")
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(
      join(markerDir, "tui-plugin-loaded.json"),
      `${JSON.stringify({ at: Date.now(), route: cfg.route, command: cfg.command, version: "0.0.1" })}\n`,
    )
  } catch {
    // the marker is diagnostic only
  }

  api.route.register([
    {
      name: cfg.route,
      render: () => <Dashboard api={api} state={state} route={cfg.route} command={cfg.command} />,
    },
  ])

  const keys = createBindingLookup({ ...defaultKeymap, ...(cfg.keybinds ?? {}) })
  api.keymap.registerLayer({
    commands: [
      {
        name: cfg.command,
        title: "Subplug: swarm dashboard",
        category: "Plugin",
        namespace: "palette",
        slashName: "subplug",
        run() {
          api.route.navigate(cfg.route)
        },
      },
    ],
    bindings: keys.gather("subplug.global", [cfg.command]),
  })

  const slot: TuiSlotPlugin = {
    order: 650,
    slots: {
      sidebar_content(ctx, value) {
        return <Sidebar state={state} sessionID={value.session_id} />
      },
    },
  }
  api.slots.register(slot)

  const disposers: Array<() => void> = []
  disposers.push(
    api.event.on("session.error", (event: { properties?: { sessionID?: string } }) => {
      const sessionID = event?.properties?.sessionID
      api.ui.toast({
        variant: "error",
        title: "subplug",
        message: `session error${sessionID ? ` ${sessionID.slice(0, 10)}` : ""}`,
        duration: 4000,
      })
      void api.attention.notify({
        title: "subplug",
        message: `session error${sessionID ? ` ${sessionID.slice(0, 10)}` : ""}`,
        notification: true,
        sound: { name: "error" },
      })
    }),
  )
  disposers.push(
    api.event.on("session.idle", (event: { properties?: { sessionID?: string } }) => {
      const sessionID = event?.properties?.sessionID
      if (!sessionID) return
      const session = state().sessions.find((item) => item.sessionID === sessionID)
      if (!session || session.kind !== "subagent") return
      api.ui.toast({
        variant: "info",
        title: "subplug",
        message: `subagent done ${sessionID.slice(0, 10)}`,
        duration: 3000,
      })
      void api.attention.notify({
        title: "subplug",
        message: "subagent done",
        sound: { name: "subagent_done" },
      })
    }),
  )

  api.lifecycle.onDispose(() => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "subplug-tui",
  tui,
}

export default plugin
