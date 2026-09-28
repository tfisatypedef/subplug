/** @jsxImportSource @opentui/solid */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { KeyEvent, RGBA, Renderable } from "@opentui/core"
import { createBindingLookup, type BindingConfig } from "@opentui/keymap/extras"
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { ClaimRecord, MonitorState, SessionNode } from "../shared/types.ts"
import { joinClaimsToSessions, lastCommandBySession, readMonitorState, type LastCommand } from "../hub/monitor.ts"
import { buildSessionTree, flattenTree, rollupSubtree, type SubtreeRollup, type TreeRow } from "../hub/tree.ts"
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
    recentCommands: [],
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

const COLLAPSE_KEY = "subplug.collapsed"

function shortID(sessionID: string): string {
  return sessionID.slice(0, 8)
}

function readCollapsed(api: TuiPluginApi): Set<string> {
  try {
    const value = api.kv.get<unknown>(COLLAPSE_KEY, [])
    if (Array.isArray(value)) {
      return new Set(value.filter((item): item is string => typeof item === "string"))
    }
  } catch {
    // collapse state is a convenience
  }
  return new Set()
}

function writeCollapsed(api: TuiPluginApi, collapsed: ReadonlySet<string>): void {
  try {
    api.kv.set(COLLAPSE_KEY, [...collapsed])
  } catch {
    // collapse state is a convenience
  }
}

function treePrefix(row: TreeRow): string {
  return row.depth > 0 ? `${"  ".repeat(row.depth - 1)}└ ` : ""
}

function commandLabel(sessionID: string, commands: Map<string, LastCommand>, now: number): string {
  const command = commands.get(sessionID)
  if (!command) return ""
  const summary = command.summary ? ` ${command.summary.slice(0, 32)}` : ""
  return ` · ${command.category}${summary} ${age(command.ts, now)} ago`
}

function rollupLabel(rollup: SubtreeRollup): string | undefined {
  const parts: string[] = []
  if (rollup.total > 1) parts.push(`${rollup.total - 1} sub`)
  if (rollup.busy) parts.push(`${rollup.busy} busy`)
  if (rollup.retry) parts.push(`${rollup.retry} retry`)
  if (rollup.error) parts.push(`${rollup.error} err`)
  if (rollup.deleted) parts.push(`${rollup.deleted} deleted`)
  if (rollup.cost) parts.push(`$${rollup.cost.toFixed(4)}`)
  return parts.length ? parts.join(" · ") : undefined
}

function rollupDetail(rollup: SubtreeRollup): string {
  const parts = [`${rollup.total} session${rollup.total === 1 ? "" : "s"}`]
  if (rollup.busy) parts.push(`${rollup.busy} busy`)
  if (rollup.retry) parts.push(`${rollup.retry} retry`)
  if (rollup.error) parts.push(`${rollup.error} err`)
  if (rollup.deleted) parts.push(`${rollup.deleted} deleted`)
  if (rollup.cost) parts.push(`$${rollup.cost.toFixed(4)}`)
  return parts.join(" · ")
}

type MessageInfo = {
  role?: string
  agent?: string
  modelID?: string
  providerID?: string
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
}

type MessageRow = { info?: MessageInfo; parts?: Array<Record<string, unknown>> }

type SessionDetailState = {
  todos: Array<{ content: string; status: string }>
  messages: Array<{ role: string; agent?: string; model?: string; text: string }>
  tokens: number
  cost: number
  contextLimit?: number
}

function unwrapData<T>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") return undefined
  const data = (response as { data?: T }).data
  return data === undefined ? (response as T) : data
}

function summarizeMessage(parts: Array<Record<string, unknown>> | undefined, maxChars = 240): string {
  const pieces: string[] = []
  for (const part of parts ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.replace(/\s+/g, " ").trim()
      if (text) pieces.push(text)
      continue
    }
    if (part.type === "tool" && typeof part.tool === "string") {
      const state = record(part.state) ? (part.state as Record<string, unknown>) : {}
      const status = typeof state.status === "string" ? state.status : ""
      pieces.push(`[${part.tool}${status ? ` ${status}` : ""}]`)
    }
  }
  const text = pieces.filter(Boolean).join(" ")
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

async function loadSessionDetail(api: TuiPluginApi, sessionID: string): Promise<SessionDetailState> {
  const state: SessionDetailState = { todos: [], messages: [], tokens: 0, cost: 0 }
  const client = api.client as unknown as {
    session: {
      todo: (input: { sessionID: string }) => Promise<unknown>
      messages: (input: { sessionID: string; limit?: number }) => Promise<unknown>
    }
  }
  const [todoResult, messageResult] = await Promise.allSettled([
    client.session.todo({ sessionID }),
    client.session.messages({ sessionID, limit: 20 }),
  ])

  if (todoResult.status === "fulfilled") {
    const rows = unwrapData<Array<{ content?: string; status?: string }>>(todoResult.value)
    if (Array.isArray(rows)) {
      state.todos = rows
        .filter((row) => typeof row?.content === "string")
        .map((row) => ({ content: String(row.content), status: String(row.status ?? "pending") }))
    }
  }

  if (messageResult.status === "fulfilled") {
    const rows = unwrapData<MessageRow[]>(messageResult.value)
    if (Array.isArray(rows)) {
      state.messages = rows.map((row) => ({
        role: String(row.info?.role ?? "?"),
        agent: row.info?.agent,
        model: row.info?.modelID,
        text: summarizeMessage(row.parts),
      }))
      const assistant = [...rows].reverse().find((row) => row.info?.role === "assistant" && row.info?.tokens)
      const tokens = assistant?.info?.tokens
      if (tokens) {
        state.tokens =
          (tokens.input ?? 0) +
          (tokens.output ?? 0) +
          (tokens.reasoning ?? 0) +
          (tokens.cache?.read ?? 0) +
          (tokens.cache?.write ?? 0)
        state.cost = assistant?.info?.cost ?? 0
        const provider = api.state.provider.find((item) => item.id === assistant?.info?.providerID)
        const modelID = assistant?.info?.modelID
        const model = modelID ? provider?.models[modelID] : undefined
        state.contextLimit = model?.limit.context
      }
    }
  }
  return state
}

function compactTokens(value: number): string {
  if (value < 1000) return `${value}`
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
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
        .sessions.slice(-8)
        .map((session) => (
          <text fg={session.sessionID === props.sessionID ? "#f0f0f0" : "#a5a5a5"}>
            {session.sessionID === props.sessionID ? "▸ " : "  "}
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

function Dashboard(props: {
  api: TuiPluginApi
  state: () => MonitorState
  route: string
  command: string
  onClose: () => void
  openSession: (sessionID: string) => void
}) {
  const snapshot = () => props.state()
  const skin = () => skinOf(props.api)
  const now = () => snapshot().generatedAt
  const holders = () => joinClaimsToSessions(snapshot().registry, snapshot().sessions)
  const sessions = () => snapshot().sessions
  const commands = () => lastCommandBySession(snapshot().recentCommands)
  const [collapsed, setCollapsed] = createSignal<Set<string>>(readCollapsed(props.api))
  const tree = () => buildSessionTree(sessions())
  const rows = () => flattenTree(tree(), collapsed())
  const [selected, setSelected] = createSignal(0)
  const current = () => Math.min(selected(), Math.max(0, rows().length - 1))

  const move = (delta: number) => {
    const total = rows().length
    if (!total) return
    setSelected(Math.max(0, Math.min(total - 1, current() + delta)))
  }
  const setCollapse = (collapse: boolean) => {
    const row = rows()[current()]
    if (!row || !row.hasChildren) return
    const next = new Set(collapsed())
    if (collapse) next.add(row.session.sessionID)
    else next.delete(row.session.sessionID)
    setCollapsed(next)
    writeCollapsed(props.api, next)
    const index = flattenTree(tree(), next).findIndex((item) => item.session.sessionID === row.session.sessionID)
    if (index >= 0) setSelected(index)
  }
  const open = () => {
    const row = rows()[current()]
    if (!row) return
    props.openSession(row.session.sessionID)
  }

  const routeKeys: BindingConfig<Renderable, KeyEvent> = {
    "subplug.select.next": "down",
    "subplug.select.prev": "up",
    "subplug.collapse": "left",
    "subplug.expand": ["right", "space"],
    "subplug.open.selected": "return",
    "subplug.dashboard.back": ["escape", "q"],
  }
  const keys = createBindingLookup(routeKeys)
  const disposeKeys = props.api.keymap.registerLayer({
    priority: 100,
    commands: [
      { name: "subplug.select.next", title: "Subplug: next session", category: "Plugin", run: () => move(1) },
      { name: "subplug.select.prev", title: "Subplug: previous session", category: "Plugin", run: () => move(-1) },
      { name: "subplug.collapse", title: "Subplug: collapse session", category: "Plugin", run: () => setCollapse(true) },
      { name: "subplug.expand", title: "Subplug: expand session", category: "Plugin", run: () => setCollapse(false) },
      {
        name: "subplug.open.selected",
        title: "Subplug: open session detail",
        category: "Plugin",
        run: () => open(),
      },
      {
        name: "subplug.dashboard.back",
        title: "Subplug: close dashboard",
        category: "Plugin",
        run: () => props.onClose(),
      },
    ],
    bindings: keys.gather("subplug.dashboard", [
      "subplug.select.next",
      "subplug.select.prev",
      "subplug.collapse",
      "subplug.expand",
      "subplug.open.selected",
      "subplug.dashboard.back",
    ]),
  })
  onCleanup(disposeKeys)

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
          {rows().length === 0 ? <text fg={skin().muted}>no sessions recorded yet</text> : null}
          {rows().map((row, index) => {
            const rollup = rollupLabel(rollupSubtree(sessions(), row.session.sessionID))
            return (
              <box flexDirection="column">
                <text fg={statusColor(skin(), row.session.status)}>
                  <span style={{ fg: index === current() ? skin().accent : skin().muted }}>
                    {index === current() ? "▸ " : "  "}
                  </span>
                  {treePrefix(row)}
                  {row.hasChildren ? (row.collapsed ? "▸ " : "▾ ") : ""}
                  {statusMark(row.session.status)} {row.orphan ? "? " : ""}
                  <span style={{ fg: skin().text }}>{sessionLabel(row.session)}</span>
                  {row.session.deleted ? <span style={{ fg: skin().error }}> [deleted]</span> : null}
                  <span style={{ fg: skin().muted }}>
                    {" "}
                    {shortID(row.session.sessionID)} {row.session.status} {age(row.session.lastEventAt, now())} ago
                    {row.session.agent ? ` agent=${row.session.agent}` : ""}
                    {row.session.model ? ` model=${row.session.model}` : ""}
                    {commandLabel(row.session.sessionID, commands(), now())}
                  </span>
                  {rollup ? <span style={{ fg: skin().success }}> [{rollup}]</span> : null}
                </text>
              </box>
            )
          })}
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

        <text fg={skin().muted}>
          ↑/↓ select · ←/→ collapse · enter open · esc/q back · /{props.route} reopens · {props.command} from the
          palette
        </text>
      </box>
    </box>
  )
}

function SessionDetail(props: {
  api: TuiPluginApi
  state: () => MonitorState
  sessionID: () => string
  trail: () => string[]
  descend: (sessionID: string) => void
  back: () => void
}) {
  const skin = () => skinOf(props.api)
  const [detail, setDetail] = createSignal<SessionDetailState>({ todos: [], messages: [], tokens: 0, cost: 0 })
  const session = () => props.state().sessions.find((item) => item.sessionID === props.sessionID())
  const children = () => props.state().sessions.filter((item) => item.parentID === props.sessionID())
  const claims = () => {
    const identity = session()?.identity
    if (!identity) return []
    return props.state().registry.claims.filter((claim) => claim.status === "active" && claim.agent === identity)
  }
  const [childIndex, setChildIndex] = createSignal(0)
  const currentChild = () => Math.min(childIndex(), Math.max(0, children().length - 1))
  const moveChild = (delta: number) => {
    const total = children().length
    if (!total) return
    setChildIndex(Math.max(0, Math.min(total - 1, currentChild() + delta)))
  }
  const descend = () => {
    const child = children()[currentChild()]
    if (!child) return
    props.descend(child.sessionID)
  }
  const ancestors = () => {
    const byID = new Map(props.state().sessions.map((item) => [item.sessionID, item]))
    const chain: SessionNode[] = []
    const seen = new Set<string>()
    let node = session()
    while (node?.parentID && !seen.has(node.parentID)) {
      seen.add(node.parentID)
      const parent = byID.get(node.parentID)
      if (!parent) break
      chain.unshift(parent)
      node = parent
    }
    return chain
  }
  const breadcrumb = () => {
    const sessionID = props.sessionID()
    const ids = props.trail().length ? props.trail() : [...ancestors().map((node) => node.sessionID), sessionID]
    const byID = new Map(props.state().sessions.map((item) => [item.sessionID, item]))
    return ids
      .map((id) => {
        const node = byID.get(id)
        return node ? sessionLabel(node) : shortID(id)
      })
      .join(" → ")
  }
  const subtree = () => rollupDetail(rollupSubtree(props.state().sessions, props.sessionID()))

  const refresh = async () => {
    try {
      setDetail(await loadSessionDetail(props.api, props.sessionID()))
    } catch {
      // detail refresh is best-effort
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 1500)
  onCleanup(() => clearInterval(timer))

  const detailKeys: BindingConfig<Renderable, KeyEvent> = {
    "subplug.detail.next": "down",
    "subplug.detail.prev": "up",
    "subplug.detail.descend": "return",
    "subplug.back": ["escape", "q"],
  }
  const keys = createBindingLookup(detailKeys)
  const disposeKeys = props.api.keymap.registerLayer({
    priority: 100,
    commands: [
      { name: "subplug.detail.next", title: "Subplug: next subagent", category: "Plugin", run: () => moveChild(1) },
      { name: "subplug.detail.prev", title: "Subplug: previous subagent", category: "Plugin", run: () => moveChild(-1) },
      { name: "subplug.detail.descend", title: "Subplug: open subagent", category: "Plugin", run: () => descend() },
      {
        name: "subplug.back",
        title: "Subplug: back",
        category: "Plugin",
        run: () => props.back(),
      },
    ],
    bindings: keys.gather("subplug.detail", [
      "subplug.detail.next",
      "subplug.detail.prev",
      "subplug.detail.descend",
      "subplug.back",
    ]),
  })
  onCleanup(disposeKeys)

  const usage = () => {
    const value = detail()
    if (!value.tokens && !value.contextLimit) return undefined
    const percent = value.contextLimit ? Math.round((value.tokens / value.contextLimit) * 100) : undefined
    const parts = [
      `tokens ${compactTokens(value.tokens)}${
        value.contextLimit ? ` / ${compactTokens(value.contextLimit)} (${percent}%)` : ""
      }`,
    ]
    if (value.cost) parts.push(`cost $${value.cost.toFixed(4)}`)
    return parts.join(" · ")
  }

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
            <span style={{ fg: skin().muted }}> session detail</span>
          </text>
          <text fg={skin().muted}>esc/q back</text>
        </box>
        <text fg={skin().muted}>{breadcrumb()}</text>
        <text fg={skin().text}>
          {session() ? `${statusMark(session()!.status)} ${sessionLabel(session()!)}` : props.sessionID()}
        </text>
        <text fg={skin().muted}>
          {shortID(props.sessionID())} · {session()?.status ?? "unknown"}
          {session()?.agent ? ` · agent=${session()!.agent}` : ""}
          {session()?.model ? ` · model=${session()!.model}` : ""}
          {session()?.identity ? ` · ${session()!.identity}` : ""}
        </text>
        <text fg={skin().success}>{subtree()}</text>
        {session()?.directory ? <text fg={skin().muted}>{session()!.directory}</text> : null}
        {usage() ? <text fg={skin().accent}>{usage()}</text> : null}

        <box
          border
          borderColor={skin().border}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
        >
          <text fg={skin().accent}>
            <b>Todos ({detail().todos.length})</b>
          </text>
          {detail().todos.length === 0 ? <text fg={skin().muted}>no todos recorded</text> : null}
          {detail()
            .todos.slice(-8)
            .map((todo) => (
              <text fg={skin().text}>
                <span style={{ fg: todo.status === "completed" ? skin().success : skin().muted }}>
                  [{todo.status}]
                </span>{" "}
                {todo.content.slice(0, 120)}
              </text>
            ))}
        </box>

        {children().length ? (
          <box
            border
            borderColor={skin().border}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <text fg={skin().accent}>
              <b>Subagents ({children().length})</b>
            </text>
            {children().map((child, index) => (
              <text fg={statusColor(skin(), child.status)}>
                <span style={{ fg: index === currentChild() ? skin().accent : skin().muted }}>
                  {index === currentChild() ? "▸ " : "  "}
                </span>
                {statusMark(child.status)} {sessionLabel(child)} {shortID(child.sessionID)}
              </text>
            ))}
          </box>
        ) : null}

        {claims().length ? (
          <box
            border
            borderColor={skin().border}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <text fg={skin().accent}>
              <b>Claims ({claims().length})</b>
            </text>
            {claims().map((claim) => (
              <text fg={skin().text}>
                <span style={{ fg: skin().muted }}>{claim.claimID.slice(-10)}</span> {claim.agent} expires=
                {claim.expires}
              </text>
            ))}
          </box>
        ) : null}

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
            <b>Conversation (last {detail().messages.length})</b>
          </text>
          {detail().messages.length === 0 ? <text fg={skin().muted}>no messages loaded</text> : null}
          {detail()
            .messages.slice(-8)
            .map((message) => (
              <text fg={message.role === "user" ? skin().text : skin().muted}>
                <span style={{ fg: message.role === "user" ? skin().accent : skin().success }}>{message.role}</span>
                {message.agent ? ` ${message.agent}` : ""}
                {message.model ? ` ${message.model}` : ""}: {message.text}
              </text>
            ))}
        </box>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return

  const cfg = config(options)
  const state = createMonitor(api, cfg)
  const [previousRoute, setPreviousRoute] = createSignal<{ name: string; params?: Record<string, unknown> }>({
    name: "home",
  })
  const closeDashboard = () => {
    const previous = previousRoute()
    if (previous.name === "session") {
      const sessionID = previous.params?.sessionID
      if (typeof sessionID === "string" && sessionID) {
        api.route.navigate("session", { sessionID })
        return
      }
    }
    if (previous.name === "home") {
      api.route.navigate("home")
      return
    }
    api.route.navigate(previous.name, previous.params)
  }

  const [detailTrail, setDetailTrail] = createSignal<string[]>([])
  const openSession = (sessionID: string) => {
    setDetailTrail([sessionID])
    api.route.navigate(`${cfg.route}.session`, { sessionID })
  }
  const descendSession = (sessionID: string) => {
    setDetailTrail((trail) => [...trail, sessionID])
    api.route.navigate(`${cfg.route}.session`, { sessionID })
  }
  const backFromDetail = () => {
    const trail = detailTrail()
    if (trail.length > 1) {
      const next = trail.slice(0, -1)
      setDetailTrail(next)
      api.route.navigate(`${cfg.route}.session`, { sessionID: next[next.length - 1] ?? next[0] ?? "" })
      return
    }
    setDetailTrail([])
    closeDashboard()
  }

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
      render: () => (
        <Dashboard
          api={api}
          state={state}
          route={cfg.route}
          command={cfg.command}
          onClose={closeDashboard}
          openSession={openSession}
        />
      ),
    },
    {
      name: `${cfg.route}.session`,
      render: (input) => (
        <SessionDetail
          api={api}
          state={state}
          sessionID={() =>
            detailTrail().at(-1) ?? (typeof input.params?.sessionID === "string" ? input.params.sessionID : "")
          }
          trail={() => detailTrail()}
          descend={descendSession}
          back={backFromDetail}
        />
      ),
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
          setPreviousRoute(api.route.current)
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
