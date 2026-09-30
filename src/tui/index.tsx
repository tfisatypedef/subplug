/** @jsxImportSource @opentui/solid */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import pkg from "../../package.json"
import { Plugin } from "@opencode/plugin/tui"
import type { RGBA, TextRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import type { MonitorState, SessionNode } from "../shared/types.ts"
import { readMonitorState } from "../hub/monitor.ts"
import { inboxFor } from "../hub/comms.ts"
import { EventLog, readEventRecords } from "../hub/append.ts"
import { FollowUpConfirmationRequired, followUpError, sendFollowUp } from "../shared/follow-up.ts"
import { rollupSubtree } from "../hub/tree.ts"
import type { TranscriptRow } from "../shared/transcript.ts"
import { fallbackStateDir, selectHubDir, readHubPointer } from "../hub/paths.ts"
import { findRepoRoot } from "../coord/repo.ts"
import { backfillSessions, listNativeSessions, loadSessionDetailV2, type SessionDetailV2 } from "./data.ts"
import { detectRemote, localInterfaceHosts } from "./remote.ts"
import { readRemoteState } from "./remote-state.ts"
import { resolveTuiOptions, type TuiContextLike, type SubplugTuiOptions } from "./context.ts"
import { Dashboard } from "./dashboard.tsx"
import {
  age,
  createMarquee,
  rollupDetail,
  sessionLabel,
  shortID,
  skinForTheme,
  statusColor,
  statusMark,
  type Skin,
} from "./presentation.ts"
import { createSessionNavigator } from "./navigation.ts"

export { Dashboard } from "./dashboard.tsx"
export { DetailsPane } from "./details-pane.tsx"
export type { Skin } from "./presentation.ts"

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

function projectIDFor(ctx: TuiContextLike): string | undefined {
  const directory = ctx.location?.directory
  const projects = ctx.data.project?.list() ?? []
  if (!directory) return projects[0]?.id
  const exact = projects.find((project) => project.canonical === directory)
  if (exact?.id) return exact.id
  const nested = projects.find(
    (project) => project.canonical && (directory.startsWith(project.canonical) || project.canonical.startsWith(directory)),
  )
  return nested?.id ?? projects[0]?.id
}

function createMonitor(ctx: TuiContextLike, cfg: SubplugTuiOptions) {
  const [state, setState] = createSignal<MonitorState>(emptyState())
  const serverID = `subplug-tui-${randomUUID()}`
  let hubDir: string | undefined
  let repoRoot: string | undefined
  let remote = false
  let resolved = false
  let backfilled = false
  let lastRiskAt = Date.now()

  const resolvePaths = async (): Promise<void> => {
    if (resolved) return
    resolved = true
    remote = await detectRemote(cfg.remote, ctx.location?.directory, {
      info: () => ctx.client.server?.info?.() ?? Promise.resolve(undefined),
      localHosts: localInterfaceHosts,
      directoryExists: (directory) => Boolean(directory && existsSync(directory)),
    })
    if (remote) return
    const explicitDir = cfg.storageDir ?? process.env.SUBPLUG_STORAGE_DIR
    const group = cfg.hubGroup ?? projectIDFor(ctx)
    const pointer = explicitDir ? undefined : readHubPointer()
    hubDir = selectHubDir({ stateDir: explicitDir ?? fallbackStateDir(), group, pointer })
    repoRoot = findRepoRoot(ctx.location?.directory ?? process.cwd())
  }

  const runBackfill = async (): Promise<void> => {
    if (backfilled || !hubDir) return
    backfilled = true
    try {
      const known = new Set(
        readEventRecords(hubDir)
          .map((record) => record.sessionID)
          .filter((id): id is string => Boolean(id)),
      )
      const native = await listNativeSessions(ctx)
      if (!native.length) return
      const log = new EventLog(hubDir, serverID)
      const written = backfillSessions(known, native, (record) => log.append(record), serverID)
      if (written) setState(readMonitorState(hubDir, repoRoot))
    } catch {
      // backfill is best-effort
    }
  }

  const tick = async (): Promise<void> => {
    try {
      await resolvePaths()
      if (remote) {
        const native = await listNativeSessions(ctx)
        setState(readRemoteState(ctx, Date.now(), native.length ? native : undefined))
        return
      }
      if (!hubDir) return
      await runBackfill()
      const next = readMonitorState(hubDir, repoRoot)
      setState(next)
      const latest = next.risks.at(-1)
      if (latest && latest.ts > lastRiskAt) {
        lastRiskAt = latest.ts
        ctx.ui.toast.show({
          variant: "warning",
          title: "subplug: claim coverage",
          message: latest.summary,
          duration: 6000,
        })
        void ctx.attention.notify({
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

  return {
    state,
    dispose: () => clearInterval(timer),
  }
}

const SIDEBAR_WIDTH = 36
const SIDEBAR_MIN_ROWS = 11
const SIDEBAR_MAX_ROWS = 24
const SIDEBAR_DEFAULT_ASPECT = 0.5

function MarqueeRow(props: { width: number; fg: RGBA | string; children: JSX.Element }) {
  let ref: TextRenderable | undefined
  const marquee = createMarquee(() => ref)
  onCleanup(() => marquee.stop())
  return (
    <text
      flexShrink={0}
      width={props.width}
      wrapMode="none"
      fg={props.fg}
      ref={(el) => {
        ref = el
      }}
      onMouseOver={() => marquee.start()}
      onMouseOut={() => marquee.stop()}
    >
      {props.children}
    </text>
  )
}

export function Sidebar(props: {
  ctx: TuiContextLike
  state: () => MonitorState
  sessionID: string
  aspect?: number
  onOpen: () => void
}) {
  const snapshot = () => props.state()
  const skin = () => skinForTheme(props.ctx.theme)
  const cellAspect = () => {
    const renderer = props.ctx.renderer
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
        const label = session.title?.trim() || session.sessionID.slice(0, 12)
        return (
          <MarqueeRow width={inner()} fg={current ? skin().text : skin().muted}>
            <span style={{ fg: current ? skin().accent : skin().muted }}>{prefix}</span>
            <span style={{ fg: statusColor(skin(), session.status) }}>{statusMark(session.status)}</span>
            {` ${kind}${label}`}
          </MarqueeRow>
        )
      })}
      <text flexShrink={0} width={inner()} wrapMode="none" truncate fg={skin().muted}>
        {snapshot().source === "remote"
          ? "remote attach · claims unavailable"
          : `claims ${activeClaims()} active${conflicts() ? ` · ${conflicts()} conflict${conflicts() === 1 ? "" : "s"}` : ""}`}
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
  ctx: TuiContextLike
  state: () => MonitorState
  sessionID: () => string
  trail: () => string[]
  descend: (sessionID: string) => void
  back: () => void
  compose: (sessionID: string, status: SessionNode["status"]) => void
  intervalMs: number
}) {
  const skin = () => skinForTheme(props.ctx.theme)
  const [detail, setDetail] = createSignal<SessionDetailV2>({ todos: [], rows: [], tokens: 0, cost: 0, source: "none" })
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
      const sessionID = props.sessionID()
      const next = await loadSessionDetailV2(props.ctx, sessionID)
      if (!disposed && sessionID === props.sessionID()) setDetail(next)
    } catch {
      // detail refresh is best-effort
    }
  }
  let disposed = false
  void refresh()
  const timer = setInterval(() => void refresh(), Math.max(500, props.intervalMs))
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
  })

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

export function createFollowUpComposer(ctx: TuiContextLike, state: () => MonitorState) {
  const serverID = `subplug-tui-${randomUUID()}`
  let eventLog: EventLog | undefined
  const record = (value: Parameters<typeof EventLog.prototype.append>[0]): void => {
    const hubDir = state().hubDir
    if (!hubDir) return
    eventLog ??= new EventLog(hubDir, serverID)
    eventLog.append(value)
  }
  const promptTarget = async (sessionID: string, text: string, confirm = false): Promise<void> => {
    try {
      const target = state().sessions.find((session) => session.sessionID === sessionID)
      if (!target) throw new Error("target session is no longer available")
      if (!state().hubDir && state().source !== "remote") throw new Error("monitor is still loading; try again shortly")
      const sent = await sendFollowUp({
        target,
        status: target.status,
        message: text,
        from: "user",
        serverID,
        confirm,
        transport: {
          get: (id) => ctx.client.session.get({ sessionID: id }),
          prompt: (request) => ctx.client.session.prompt(request),
        },
        record,
      })
      ctx.ui.toast.show({
        variant: "success",
        title: "subplug",
        message: `${sent.noReply ? "follow-up queued" : "follow-up sent; agent resuming"} to ${shortID(sessionID)}`,
        duration: 3000,
      })
    } catch (error) {
      if (error instanceof FollowUpConfirmationRequired) {
        const confirmed = await ctx.ui.dialog.confirm({
          title: `agent is ${error.status}`,
          message: "Send this follow-up context at the agent's next step? It may affect work already in progress.",
          label: { confirm: "Queue follow-up", cancel: "Cancel" },
        })
        if (confirmed) await promptTarget(sessionID, text, true)
        return
      }
      ctx.ui.toast.show({
        variant: "error",
        title: "subplug",
        message: `follow-up failed: ${followUpError(error)}`,
        duration: 5000,
      })
    }
  }
  return async (sessionID: string, status: SessionNode["status"]): Promise<void> => {
    if (!sessionID) return
    const target = state().sessions.find((session) => session.sessionID === sessionID)
    const value = await ctx.ui.dialog.prompt({
      title: `Follow-up: ${target ? sessionLabel(target) : shortID(sessionID)}`,
      placeholder: "Additional context or instructions",
      description:
        status === "idle"
          ? "Sending resumes this agent with your follow-up context."
          : "Running agents receive context at their next step; you will confirm before sending.",
    })
    if (value === undefined) return
    const text = value.trim()
    if (text) await promptTarget(sessionID, text)
  }
}

function GlobalKeys(props: { ctx: TuiContextLike; route: string; open: () => void }) {
  props.ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "subplug.open",
        title: "Subplug: swarm dashboard",
        group: "Plugin",
        bind: "ctrl+alt+a",
        palette: true,
        slash: { name: "subplug" },
        run: () => props.open(),
      },
    ],
  }))
  return <box width={0} height={0} />
}

const tui = Plugin.define({
  id: "subplug-tui",
  async setup(rawContext) {
    const ctx = rawContext as unknown as TuiContextLike
    const cfg = resolveTuiOptions(ctx.options)
    const monitor = createMonitor(ctx, cfg)
    const state = monitor.state
    const [previousRoute, setPreviousRoute] = createSignal<{ type: string; sessionID?: string; name?: string }>({
      type: "home",
    })
    const closeDashboard = () => {
      const previous = previousRoute()
      if (previous.type === "session" && previous.sessionID) {
        ctx.ui.router.navigate({ type: "session", sessionID: previous.sessionID })
        return
      }
      ctx.ui.router.navigate({ type: "home" })
    }

    const openDashboard = () => {
      setPreviousRoute(ctx.ui.router.current())
      ctx.ui.router.navigate({ type: "plugin", name: cfg.route })
    }
    const previousSessionID = () => (previousRoute().type === "session" ? previousRoute().sessionID : undefined)

    const [detailTrail, setDetailTrail] = createSignal<string[]>([])
    const openSession = createSessionNavigator(ctx, cfg.route, (id) => setDetailTrail([id]))
    const descendSession = (sessionID: string) => {
      setDetailTrail((trail) => [...trail, sessionID])
      ctx.ui.router.navigate({ type: "plugin", name: `${cfg.route}.session`, data: { sessionID } })
    }
    const backFromDetail = () => {
      const trail = detailTrail()
      if (trail.length > 1) {
        const next = trail.slice(0, -1)
        setDetailTrail(next)
        ctx.ui.router.navigate({
          type: "plugin",
          name: `${cfg.route}.session`,
          data: { sessionID: next[next.length - 1] ?? next[0] ?? "" },
        })
        return
      }
      setDetailTrail([])
      closeDashboard()
    }

    const compose = createFollowUpComposer(ctx, state)

    try {
      const markerDir = join(cfg.storageDir ?? fallbackStateDir(), "subplug")
      mkdirSync(markerDir, { recursive: true })
      writeFileSync(
        join(markerDir, "tui-plugin-loaded.json"),
        `${JSON.stringify({ at: Date.now(), route: cfg.route, version: pkg.version })}\n`,
      )
    } catch {
      // the marker is diagnostic only
    }

    const disposers: Array<() => void> = []
    disposers.push(
      ctx.ui.router.register({
        name: cfg.route,
        render: () => (
          <Dashboard
            ctx={ctx}
            state={state}
            currentSession={previousSessionID}
            onClose={closeDashboard}
            openSession={openSession}
            compose={compose}
          />
        ),
      }),
    )
    disposers.push(
      ctx.ui.router.register({
        name: `${cfg.route}.session`,
        render: (input) => (
          <SessionDetail
            ctx={ctx}
            state={state}
            sessionID={() =>
              detailTrail().at(-1) ?? (typeof input.data?.sessionID === "string" ? input.data.sessionID : "")
            }
            trail={() => detailTrail()}
            descend={descendSession}
            back={backFromDetail}
            compose={compose}
            intervalMs={cfg.intervalMs}
          />
        ),
      }),
    )
    disposers.push(
      ctx.ui.slot({
        append: "app",
        render: () => <GlobalKeys ctx={ctx} route={cfg.route} open={openDashboard} />,
      }),
    )
    disposers.push(
      ctx.ui.slot({
        append: "sidebar.content",
        render: (input) => (
          <Sidebar ctx={ctx} aspect={cfg.sidebarAspect} state={state} sessionID={input.sessionID} onOpen={openDashboard} />
        ),
      }),
    )

    const eventSessionID = (event: unknown): string | undefined => {
      if (!event || typeof event !== "object") return undefined
      const data = (event as { data?: unknown }).data
      if (!data || typeof data !== "object") return undefined
      const id = (data as { sessionID?: unknown }).sessionID
      return typeof id === "string" && id ? id : undefined
    }

    const unwatchError = ctx.data.on?.("session.execution.failed", (event: unknown) => {
      const sessionID = eventSessionID(event)
      ctx.ui.toast.show({
        variant: "error",
        title: "subplug",
        message: `session error${sessionID ? ` ${sessionID.slice(0, 10)}` : ""}`,
        duration: 4000,
        ...(sessionID ? { sessionID } : {}),
      })
      void ctx.attention.notify({
        title: "subplug",
        message: `session error${sessionID ? ` ${sessionID.slice(0, 10)}` : ""}`,
        notification: true,
        sound: { name: "error" },
      })
    })
    if (typeof unwatchError === "function") disposers.push(unwatchError)

    const unwatchIdle = ctx.data.on?.("session.idle", (event: unknown) => {
      const sessionID = eventSessionID(event)
      if (!sessionID) return
      const session = state().sessions.find((item) => item.sessionID === sessionID)
      if (!session || session.kind !== "subagent") return
      ctx.ui.toast.show({
        variant: "info",
        title: "subplug",
        message: `subagent done ${sessionID.slice(0, 10)}`,
        duration: 3000,
        sessionID,
      })
      void ctx.attention.notify({
        title: "subplug",
        message: "subagent done",
        sound: { name: "subagent_done" },
      })
    })
    if (typeof unwatchIdle === "function") disposers.push(unwatchIdle)

    return () => {
      monitor.dispose()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // ignore
        }
      }
    }
  },
})

export default tui
