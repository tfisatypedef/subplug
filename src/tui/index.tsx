/** @jsxImportSource @opentui/solid */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import pkg from "../../package.json"
import type { KeyEvent, RGBA, Renderable } from "@opentui/core"
import { createBindingLookup, type BindingConfig } from "@opentui/keymap/extras"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { MonitorState, SessionNode } from "../shared/types.ts"
import { readMonitorState } from "../hub/monitor.ts"
import { inboxFor } from "../hub/comms.ts"
import { EventLog } from "../hub/append.ts"
import { FollowUpConfirmationRequired, followUpError, sendFollowUp } from "../shared/follow-up.ts"
import { rollupSubtree } from "../hub/tree.ts"
import type { TranscriptRow } from "../shared/transcript.ts"
import { hubRoot } from "../hub/paths.ts"
import { findRepoRoot } from "../coord/repo.ts"
import { Dashboard } from "./dashboard.tsx"
import { age, rollupDetail, sessionLabel, shortID, skinOf, statusColor, statusMark, type Skin } from "./presentation.ts"
import { loadSessionDetail, type SessionDetailState } from "./transcript.ts"
import { createSessionNavigator } from "./navigation.ts"

export { Dashboard } from "./dashboard.tsx"
export type { Skin } from "./presentation.ts"

type Cfg = {
  route: string
  command: string
  keybinds: BindingConfig<Renderable, KeyEvent> | undefined
  intervalMs: number
  sidebarAspect: number
  storageDir: string | undefined
  hubGroup: string | undefined
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
    sidebarAspect: num(options?.sidebarAspect, 0.5),
    storageDir: pick(options?.storageDir, "") || pick(coord?.storageDir, "") || process.env.SUBPLUG_STORAGE_DIR || undefined,
    hubGroup: pick(options?.hubGroup, "") || pick(coord?.hubGroup, "") || process.env.SUBPLUG_HUB_GROUP || undefined,
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
    comms: [],
    registry: { claims: [], verifications: [], conflicts: [], errors: [] },
  }
}

export function transcriptLine(row: TranscriptRow, skin: Skin) {
  switch (row.kind) {
    case "text":
      return (
        <text flexShrink={0} fg={row.role === "user" ? skin.text : skin.muted}>
          <span style={{ fg: row.role === "user" ? skin.accent : skin.success }}>{row.role}</span>
          {row.agent ? ` ${row.agent}` : ""}: {row.text}
        </text>
      )
    case "reasoning":
      return (
        <text flexShrink={0} fg={skin.muted}>
          [reasoning {compactTokens(row.chars)}] {row.preview ?? ""}
        </text>
      )
    case "tool":
      return (
        <box flexShrink={0} flexDirection="column">
          <text flexShrink={0} fg={row.status === "error" ? skin.error : row.status === "running" ? skin.success : skin.muted}>
            [tool] {row.tool} {row.status}
            {row.title ? ` · ${row.title}` : ""}
            {typeof row.elapsedMs === "number" ? ` · ${formatDuration(row.elapsedMs)}` : ""}
          </text>
          {row.error ? <text flexShrink={0} fg={skin.error}> {row.error}</text> : null}
          {row.outputTail ? <text flexShrink={0} fg={skin.muted}> {row.outputTail}</text> : null}
        </box>
      )
    case "file":
      return (
        <text flexShrink={0} fg={skin.muted}>
          [file] {row.filename}
          {row.mime ? ` (${row.mime})` : ""}
        </text>
      )
    case "patch":
      return (
        <text flexShrink={0} fg={skin.muted}>
          [patch] {row.files} file{row.files === 1 ? "" : "s"}
        </text>
      )
    case "agent":
      return <text flexShrink={0} fg={skin.muted}>[agent] {row.name}</text>
    case "retry":
      return <text flexShrink={0} fg={skin.warning}>[retry #{row.attempt}]</text>
    case "compaction":
      return <text flexShrink={0} fg={skin.warning}>[compaction{row.auto ? " auto" : ""}]</text>
    case "step":
      return (
        <text flexShrink={0} fg={skin.muted}>
          [step]
          {typeof row.cost === "number" ? ` $${row.cost.toFixed(4)}` : ""}
          {typeof row.tokens === "number" ? ` · ${compactTokens(row.tokens)} tokens` : ""}
        </text>
      )
    default:
      return <text flexShrink={0} fg={skin.muted}>[{row.label}]</text>
  }
}

const TRANSCRIPT_WINDOW = 10

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
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
    hubDir = hubRoot(cfg.storageDir ?? api.state.path.state, cfg.hubGroup ?? projectID)
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

const SIDEBAR_WIDTH = 36
const SIDEBAR_MIN_ROWS = 11
const SIDEBAR_MAX_ROWS = 24
const SIDEBAR_DEFAULT_ASPECT = 0.5

function ellipsize(value: string, width: number): string {
  if (value.length <= width) return value
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`
}

export function Sidebar(props: {
  api: TuiPluginApi
  state: () => MonitorState
  sessionID: string
  aspect?: number
  onOpen: () => void
}) {
  const snapshot = () => props.state()
  const skin = () => skinOf(props.api)
  const cellAspect = () => {
    const renderer = props.api.renderer
    const resolution = renderer?.resolution
    const cols = renderer?.terminalWidth || renderer?.width
    const rows = renderer?.terminalHeight || renderer?.height
    if (resolution && cols && rows && resolution.height > 0) {
      return resolution.width / cols / (resolution.height / rows)
    }
    const fallback = props.aspect ?? SIDEBAR_DEFAULT_ASPECT
    return Number.isFinite(fallback) && fallback > 0 ? fallback : SIDEBAR_DEFAULT_ASPECT
  }
  const panelWidth = () => SIDEBAR_WIDTH
  const panelHeight = () =>
    Math.max(SIDEBAR_MIN_ROWS, Math.min(SIDEBAR_MAX_ROWS, Math.round(panelWidth() * cellAspect())))
  const inner = () => panelWidth() - 4
  const sessions = () => snapshot().sessions.slice(-5)
  const activeClaims = () => snapshot().registry.claims.filter((claim) => claim.status === "active").length
  const conflicts = () => snapshot().registry.conflicts.length
  return (
    <scrollbox
      flexShrink={0}
      width={panelWidth()}
      height={panelHeight()}
      border
      borderStyle="single"
      borderColor={skin().border}
      scrollY
      viewportCulling={false}
      paddingLeft={1}
      paddingRight={1}
      contentOptions={{ flexDirection: "column" }}
      onMouseDown={() => props.onOpen()}
    >
      <text flexShrink={0} width={inner()} wrapMode="none" truncate fg={skin().text}>
        <b>Agents</b>
        <span style={{ fg: skin().muted }}> subplug</span>
      </text>
      {sessions().length === 0 ? (
        <text flexShrink={0} width={inner()} wrapMode="none" truncate fg={skin().muted}>
          no sessions seen yet
        </text>
      ) : null}
      {sessions().map((session) => {
        const current = session.sessionID === props.sessionID
        const prefix = current ? "▸ " : "  "
        const kind = session.kind === "subagent" ? "└ " : ""
        const labelWidth = Math.max(4, inner() - prefix.length - 2 - kind.length)
        return (
          <text flexShrink={0} width={inner()} wrapMode="none" truncate fg={current ? skin().text : skin().muted}>
            <span style={{ fg: current ? skin().accent : skin().muted }}>{prefix}</span>
            <span style={{ fg: statusColor(skin(), session.status) }}>{statusMark(session.status)}</span>
            {` ${kind}${ellipsize(sessionLabel(session), labelWidth)}`}
          </text>
        )
      })}
      <text flexShrink={0} width={inner()} wrapMode="none" truncate fg={skin().muted}>
        {`claims ${activeClaims()} active${conflicts() ? ` · ${conflicts()} conflict${conflicts() === 1 ? "" : "s"}` : ""}`}
      </text>
      <text flexShrink={0} width={inner()} wrapMode="none" truncate fg={skin().muted}>
        click or ctrl+alt+a
      </text>
      <text flexShrink={0} width={inner()} wrapMode="none" truncate fg={skin().muted}>
        /subplug to open
      </text>
    </scrollbox>
  )
}

export function SessionDetail(props: {
  api: TuiPluginApi
  state: () => MonitorState
  sessionID: () => string
  trail: () => string[]
  descend: (sessionID: string) => void
  back: () => void
  compose: (sessionID: string, status: SessionNode["status"]) => void
  intervalMs: number
}) {
  const skin = () => skinOf(props.api)
  const [detail, setDetail] = createSignal<SessionDetailState>({ todos: [], rows: [], tokens: 0, cost: 0, source: "none" })
  const [scroll, setScroll] = createSignal(0)
  const maxScroll = () => Math.max(0, detail().rows.length - TRANSCRIPT_WINDOW)
  const visibleRows = () => {
    const rows = detail().rows
    const end = Math.max(0, rows.length - Math.min(scroll(), maxScroll()))
    return rows.slice(Math.max(0, end - TRANSCRIPT_WINDOW), end)
  }
  const session = () => props.state().sessions.find((item) => item.sessionID === props.sessionID())
  const children = () => props.state().sessions.filter((item) => item.parentID === props.sessionID())
  const claims = () => {
    const identity = session()?.identity
    if (!identity) return []
    return props.state().registry.claims.filter((claim) => claim.status === "active" && claim.agent === identity)
  }
  const inbox = () => inboxFor(props.state().comms, props.sessionID(), { now: props.state().generatedAt })
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
  const timer = setInterval(() => void refresh(), Math.max(500, props.intervalMs))
  onCleanup(() => clearInterval(timer))
  createEffect(() => {
    props.sessionID()
    setScroll(0)
  })

  const detailKeys: BindingConfig<Renderable, KeyEvent> = {
    "subplug.detail.next": "down",
    "subplug.detail.prev": "up",
    "subplug.detail.descend": "return",
    "subplug.detail.scroll.up": "pageup",
    "subplug.detail.scroll.down": "pagedown",
    "subplug.detail.compose": ["f", "m"],
    "subplug.back": ["escape", "q"],
  }
  const keys = createBindingLookup(detailKeys)
  const disposeKeys = props.api.keymap.registerLayer({
    priority: 100,
    enabled: () => !props.api.ui.dialog.open,
    commands: [
      { name: "subplug.detail.next", title: "Subplug: next subagent", category: "Plugin", run: () => moveChild(1) },
      { name: "subplug.detail.prev", title: "Subplug: previous subagent", category: "Plugin", run: () => moveChild(-1) },
      { name: "subplug.detail.descend", title: "Subplug: open subagent", category: "Plugin", run: () => descend() },
      {
        name: "subplug.detail.scroll.up",
        title: "Subplug: scroll transcript up",
        category: "Plugin",
        run: () => setScroll(Math.min(maxScroll(), scroll() + TRANSCRIPT_WINDOW)),
      },
      {
        name: "subplug.detail.scroll.down",
        title: "Subplug: scroll transcript down",
        category: "Plugin",
        run: () => setScroll(Math.max(0, scroll() - TRANSCRIPT_WINDOW)),
      },
      {
        name: "subplug.detail.compose",
        title: "Subplug: send follow-up context",
        category: "Plugin",
        run: () => props.compose(props.sessionID(), session()?.status ?? "unknown"),
      },
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
      "subplug.detail.scroll.up",
      "subplug.detail.scroll.down",
      "subplug.detail.compose",
      "subplug.back",
    ]),
  })
  onCleanup(disposeKeys)

  const usage = () => {
    const value = detail()
    if (!value.tokens && !value.contextLimit) return undefined
    const percent = value.contextLimit ? Math.round((value.tokens / value.contextLimit) * 100) : undefined
    const parts = [
      `context ${compactTokens(value.tokens)}${
        value.contextLimit ? ` / ${compactTokens(value.contextLimit)} (${percent}%)` : ""
      }`,
    ]
    if (value.cost) parts.push(`cost $${value.cost.toFixed(4)}`)
    if (value.source !== "none") parts.push(`src ${value.source}`)
    return parts.join(" · ")
  }

  return (
    <box flexGrow={1} minHeight={0} overflow="hidden" backgroundColor={skin().panel} flexDirection="column">
      <box
        flexDirection="column"
        alignItems="stretch"
        flexGrow={1}
        minHeight={0}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between">
          <text flexShrink={0} fg={skin().text}>
            <b>subplug</b>
            <span style={{ fg: skin().muted }}> session detail</span>
          </text>
          <text flexShrink={0} fg={skin().muted}>esc/q back</text>
        </box>
        <text flexShrink={0} fg={skin().muted}>{breadcrumb()}</text>
        <box flexShrink={0} flexDirection="row" justifyContent="space-between">
          <text flexShrink={0} fg={skin().text}>
            {session() ? `${statusMark(session()!.status)} ${sessionLabel(session()!)}` : props.sessionID()}
          </text>
          <text
            flexShrink={0}
            fg={skin().accent}
            onMouseDown={() => props.compose(props.sessionID(), session()?.status ?? "unknown")}
          >
            [f] Follow up
          </text>
        </box>
        <text flexShrink={0} fg={skin().muted}>
          {shortID(props.sessionID())} · {session()?.status ?? "unknown"}
          {session()?.agent ? ` · agent=${session()!.agent}` : ""}
          {session()?.model ? ` · model=${session()!.model}` : ""}
          {session()?.identity ? ` · ${session()!.identity}` : ""}
        </text>
        <text flexShrink={0} fg={skin().success}>{subtree()}</text>
        {session()?.directory ? <text flexShrink={0} fg={skin().muted}>{session()!.directory}</text> : null}
        {usage() ? <text flexShrink={0} fg={skin().accent}>{usage()}</text> : null}

        <box
          border
          borderColor={skin().border}
          flexDirection="column"
          flexShrink={0}
          overflow="hidden"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
        >
          <text flexShrink={0} fg={skin().accent}>
            <b>Todos ({detail().todos.length})</b>
          </text>
          {detail().todos.length === 0 ? <text flexShrink={0} fg={skin().muted}>no todos recorded</text> : null}
          {detail()
            .todos.slice(-8)
            .map((todo) => (
              <text flexShrink={0} fg={skin().text}>
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
            flexShrink={0}
            overflow="hidden"
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <text flexShrink={0} fg={skin().accent}>
              <b>Subagents ({children().length})</b>
            </text>
            {children().map((child, index) => (
              <text flexShrink={0} fg={statusColor(skin(), child.status)}>
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
            flexShrink={0}
            overflow="hidden"
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <text flexShrink={0} fg={skin().accent}>
              <b>Claims ({claims().length})</b>
            </text>
            {claims().map((claim) => (
              <text flexShrink={0} fg={skin().text}>
                <span style={{ fg: skin().muted }}>{claim.claimID.slice(-10)}</span> {claim.agent} expires=
                {claim.expires}
              </text>
            ))}
          </box>
        ) : null}

        {inbox().length ? (
          <box
            border
            borderColor={skin().border}
            flexDirection="column"
            flexShrink={0}
            overflow="hidden"
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <text flexShrink={0} fg={skin().accent}>
              <b>Inbox ({inbox().length} pending)</b>
            </text>
            {inbox().map((pointer) => (
              <text flexShrink={0} fg={skin().text}>
                <span style={{ fg: skin().muted }}>{pointer.msgID.slice(-8)}</span> {pointer.from}{" "}
                {age(pointer.ts, props.state().generatedAt)} ago: {pointer.summary}
              </text>
            ))}
          </box>
        ) : null}

        <box
          border
          borderColor={skin().border}
          flexDirection="column"
          flexShrink={1}
          overflow="hidden"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
          flexGrow={1}
        >
          <box flexShrink={0} flexDirection="row" justifyContent="space-between">
            <text flexShrink={0} fg={skin().accent}>
              <b>Conversation ({detail().rows.length} rows)</b>
            </text>
            <text flexShrink={0} fg={skin().muted}>
              ↑/↓ subagent · f/m follow-up · pgup/pgdn scroll{scroll() ? ` (${scroll()})` : ""}
            </text>
          </box>
          {detail().rows.length === 0 ? <text flexShrink={0} fg={skin().muted}>no transcript loaded</text> : null}
          {visibleRows().map((row) => transcriptLine(row, skin()))}
        </box>
      </box>
    </box>
  )
}

export function createFollowUpComposer(api: TuiPluginApi, state: () => MonitorState) {
  const { DialogConfirm, DialogPrompt } = api.ui
  const serverID = `subplug-tui-${randomUUID()}`
  let eventLog: EventLog | undefined
  const promptTarget = async (sessionID: string, text: string, confirm = false): Promise<void> => {
    try {
      const target = state().sessions.find((session) => session.sessionID === sessionID)
      if (!target) throw new Error("target session is no longer available")
      if (!state().hubDir) throw new Error("monitor is still loading; try again shortly")
      const sent = await sendFollowUp({
        target,
        message: text,
        from: "user",
        serverID,
        confirm,
        transport: {
          get: (sessionID, directory) => api.client.session.get({ sessionID, directory }, { throwOnError: true }),
          status: (directory) => api.client.session.status({ directory }, { throwOnError: true }),
          prompt: (request) => api.client.session.prompt(request, { throwOnError: true }),
          promptAsync: (request) => api.client.session.promptAsync(request, { throwOnError: true }),
        },
        record: (record) => {
          eventLog ??= new EventLog(state().hubDir, serverID)
          eventLog.append(record)
        },
      })
      api.ui.toast({
        variant: "success",
        title: "subplug",
        message: `${sent.noReply ? "follow-up queued" : "follow-up sent; agent resuming"} to ${shortID(sessionID)}`,
        duration: 3000,
      })
    } catch (error) {
      if (error instanceof FollowUpConfirmationRequired) {
        api.ui.dialog.replace(
          () => (
            <DialogConfirm
              title={`agent is ${error.status}`}
              message="Send this follow-up context at the agent's next step? It may affect work already in progress."
              onConfirm={() => {
                api.ui.dialog.clear()
                void promptTarget(sessionID, text, true)
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ),
          () => undefined,
        )
        return
      }
      api.ui.toast({
        variant: "error",
        title: "subplug",
        message: `follow-up failed: ${followUpError(error)}`,
        duration: 5000,
      })
    }
  }
  return (sessionID: string, status: SessionNode["status"]): void => {
    if (!sessionID) return
    const target = state().sessions.find((session) => session.sessionID === sessionID)
    api.ui.dialog.replace(
      () => (
        <DialogPrompt
          title={`Follow-up: ${target ? sessionLabel(target) : shortID(sessionID)}`}
          placeholder="Additional context or instructions"
          description={() => (
            <text>
              {status === "idle"
                ? "Sending resumes this agent with your follow-up context."
                : "Running agents receive context at their next step; you will confirm before sending."}
            </text>
          )}
          onConfirm={(value: string) => {
            api.ui.dialog.clear()
            const text = value.trim()
            if (text) void promptTarget(sessionID, text)
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ),
      () => undefined,
    )
  }
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

  const openDashboard = () => {
    setPreviousRoute(api.route.current)
    api.route.navigate(cfg.route)
  }

  const previousSessionID = () => {
    const previous = previousRoute()
    if (previous.name === "session") {
      const sessionID = previous.params?.sessionID
      if (typeof sessionID === "string" && sessionID) return sessionID
    }
    return undefined
  }

  const [detailTrail, setDetailTrail] = createSignal<string[]>([])
  const openSession = createSessionNavigator(api, cfg.route, (id) => setDetailTrail([id]))
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

  const compose = createFollowUpComposer(api, state)

  try {
    const markerDir = join(cfg.storageDir ?? api.state.path.state, "subplug")
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(
      join(markerDir, "tui-plugin-loaded.json"),
      `${JSON.stringify({ at: Date.now(), route: cfg.route, command: cfg.command, version: pkg.version })}\n`,
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
          currentSession={previousSessionID}
          onClose={closeDashboard}
          openSession={openSession}
          compose={compose}
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
          compose={compose}
          intervalMs={cfg.intervalMs}
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
          openDashboard()
        },
      },
    ],
    bindings: keys.gather("subplug.global", [cfg.command]),
  })

  const slot: TuiSlotPlugin = {
    order: 650,
    slots: {
      sidebar_content(ctx, value) {
        return (
          <Sidebar
            api={api}
            aspect={cfg.sidebarAspect}
            state={state}
            sessionID={value.session_id}
            onOpen={openDashboard}
          />
        )
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
