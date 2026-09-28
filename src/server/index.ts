import { hostname } from "node:os"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { tool } from "@opencode-ai/plugin"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { categorizeCommand, summarizeCommand, summarizeError } from "../shared/redact.ts"
import type { EventRecord, SessionNode } from "../shared/types.ts"
import { EventLog, readEventRecords } from "../hub/append.ts"
import { applyRecord } from "../hub/fold.ts"
import { agentIdentity } from "../hub/identity.ts"
import { readMonitorState } from "../hub/monitor.ts"
import { buildSessionTree, flattenTree, rollupSubtree } from "../hub/tree.ts"
import { applyCommsRecord, buildInboxBlock, inboxFor, messageSummary, resolveTargets } from "../hub/comms.ts"
import { fallbackStateDir, hubRoot, snapshotFile } from "../hub/paths.ts"
import { findRepoRoot, isCoordinationEnabled } from "../coord/repo.ts"
import { buildRegistryState, coverageErrors, readAdoptionPaths } from "../coord/claims.ts"
import type { ClaimRecord, CommsPointer, MonitorState, RegistryState, RiskRecord } from "../shared/types.ts"

const SERVER_ID = "subplug"

type ShellPromise = {
  quiet(): ShellPromise
  nothrow(): ShellPromise
  text(encoding?: string): Promise<string>
}

type ShellRunner = (strings: TemplateStringsArray, ...expressions: unknown[]) => ShellPromise

type SubplugOptions = {
  injectIdentity: boolean
  injectComms: boolean
  storageDir?: string
  retentionBytes?: number
  maxAgeMs: number
}

type SessionInfo = {
  id?: string
  projectID?: string
  directory?: string
  parentID?: string
  title?: string
  cost?: number
  time?: { created?: number; updated?: number }
}

type SessionStatusInfo = { type?: string }

type MessageRow = { info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }

type SessionDetail = {
  session: SessionNode
  children: SessionNode[]
  claims: ClaimRecord[]
  commands: EventRecord[]
  risks: RiskRecord[]
  todos: Array<{ content: string; status: string }>
  messages: Array<{ role: string; agent?: string; model?: string; text: string }>
}

const BASELINE_LIMIT = 50
const MESSAGE_LIMIT = 50

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value === "true" || value === "1"
  return fallback
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function unwrap<T>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") return undefined
  const data = (response as { data?: T }).data
  return data === undefined ? (response as T) : data
}

function resolveOptions(options?: Record<string, unknown>): SubplugOptions {
  const root = asRecord(options)
  const coord = asRecord(root.coord)
  const comms = asRecord(root.comms)
  const envInject = toBool(process.env.SUBPLUG_INJECT_IDENTITY, false)
  const envStorage = toStringValue(process.env.SUBPLUG_STORAGE_DIR)
  return {
    injectIdentity: toBool(coord.injectIdentity, toBool(root.injectIdentity, envInject)),
    injectComms: toBool(comms.inject, toBool(root.injectComms, true)),
    storageDir: toStringValue(coord.storageDir) ?? toStringValue(root.storageDir) ?? envStorage,
    retentionBytes: toNumber(coord.retentionBytes) ?? toNumber(root.retentionBytes),
    maxAgeMs: toNumber(coord.maxAgeMs) ?? toNumber(root.maxAgeMs) ?? 24 * 60 * 60 * 1000,
  }
}

const STATE_DIR_ATTEMPTS = 3
const STATE_DIR_RETRY_MS = 150

async function resolveStateDir(input: PluginInput, override?: string): Promise<string> {
  if (override) return override
  for (let attempt = 0; attempt < STATE_DIR_ATTEMPTS; attempt += 1) {
    try {
      const response = (await input.client.path.get()) as unknown as { data?: { state?: string }; state?: string }
      const data = response?.data ?? response
      if (data && typeof data.state === "string" && data.state) return data.state
    } catch {
      // the server may not be serving yet during bootstrap; retry briefly
    }
    if (attempt < STATE_DIR_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, STATE_DIR_RETRY_MS))
    }
  }
  return fallbackStateDir()
}

async function gitUserName($: ShellRunner | undefined, cwd: string): Promise<string> {
  if (!$) return ""
  try {
    const output = await $`git -C ${cwd} config user.name`.quiet().nothrow().text()
    return output.trim()
  } catch {
    return ""
  }
}

function recordFor(
  serverID: string,
  event: { type: string; properties?: Record<string, unknown> },
  now: number,
): EventRecord | undefined {
  const properties = event.properties ?? {}
  switch (event.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted": {
      const info = asRecord(properties.info)
      const sessionID = toStringValue(info.id)
      if (!sessionID) return undefined
      const refs: Record<string, string | number | null> = {
        title: toStringValue(info.title) ?? null,
        directory: toStringValue(info.directory) ?? null,
        parentID: toStringValue(info.parentID) ?? null,
        cost: typeof info.cost === "number" && Number.isFinite(info.cost) ? info.cost : null,
      }
      return {
        ts: now,
        serverID,
        sessionID,
        parentID: toStringValue(info.parentID),
        kind: event.type as EventRecord["kind"],
        refs,
      }
    }
    case "session.status": {
      const sessionID = toStringValue(properties.sessionID)
      if (!sessionID) return undefined
      const status = asRecord(properties.status)
      return {
        ts: now,
        serverID,
        sessionID,
        kind: "session.status",
        refs: { status: toStringValue(status.type) ?? null },
      }
    }
    case "session.idle": {
      const sessionID = toStringValue(properties.sessionID)
      if (!sessionID) return undefined
      return { ts: now, serverID, sessionID, kind: "session.idle" }
    }
    case "session.error": {
      const sessionID = toStringValue(properties.sessionID)
      return {
        ts: now,
        serverID,
        sessionID,
        kind: "session.error",
        summary: summarizeError(properties.error),
      }
    }
    case "todo.updated": {
      const sessionID = toStringValue(properties.sessionID)
      if (!sessionID) return undefined
      const todos = Array.isArray(properties.todos) ? properties.todos : []
      const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 }
      for (const item of todos) {
        const status = toStringValue(asRecord(item).status)
        if (status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled") {
          counts[status] += 1
        }
      }
      return {
        ts: now,
        serverID,
        sessionID,
        kind: "todo.updated",
        refs: { total: todos.length, ...counts },
      }
    }
    case "message.updated": {
      const info = asRecord(properties.info)
      if (!info || Object.keys(info).length === 0) return undefined
      const sessionID = toStringValue(info.sessionID)
      if (!sessionID) return undefined
      const role = toStringValue(info.role)
      if (role === "user") {
        const agent = toStringValue(info.agent)
        if (agent) {
          return { ts: now, serverID, sessionID, kind: "session.agent", refs: { agent } }
        }
      }
      const modelID = toStringValue(info.modelID)
      if (modelID) {
        return { ts: now, serverID, sessionID, kind: "session.model", refs: { model: modelID } }
      }
      return undefined
    }
    case "command.executed": {
      const sessionID = toStringValue(properties.sessionID)
      if (!sessionID) return undefined
      const name = toStringValue(properties.name) ?? "command"
      return {
        ts: now,
        serverID,
        sessionID,
        kind: "command",
        summary: name,
        refs: { source: "command.executed" },
      }
    }
    default:
      return undefined
  }
}

function pickSession(sessions: SessionNode[], ref: string): SessionNode | undefined {
  const value = ref.trim()
  if (!value) return undefined
  const exact = sessions.find((session) => session.sessionID === value)
  if (exact) return exact
  const matches = sessions.filter((session) => session.sessionID.startsWith(value))
  return matches.length === 1 ? matches[0] : undefined
}

function summarizeParts(parts: Array<Record<string, unknown>> | undefined, maxChars = 240): string {
  const pieces: string[] = []
  for (const part of parts ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.replace(/\s+/g, " ").trim()
      if (text) pieces.push(text)
      continue
    }
    if (part.type === "tool" && typeof part.tool === "string") {
      const status = toStringValue(asRecord(part.state).status) ?? ""
      pieces.push(`[tool ${part.tool}${status ? ` ${status}` : ""}]`)
    }
  }
  const text = pieces.filter(Boolean).join(" ")
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

function renderSessionDetail(detail: SessionDetail): string {
  const lines: string[] = []
  const session = detail.session
  const ageSeconds = Math.max(0, Math.round((Date.now() - session.lastEventAt) / 1000))
  lines.push(`session ${session.sessionID}`)
  lines.push(`  title: ${session.title ?? "(untitled)"}`)
  lines.push(`  kind: ${session.kind}${session.parentID ? ` parent=${session.parentID}` : ""}`)
  lines.push(
    `  status: ${session.status}${session.agent ? ` agent=${session.agent}` : ""}${
      session.model ? ` model=${session.model}` : ""
    }`,
  )
  if (session.identity) lines.push(`  identity: ${session.identity}`)
  if (session.directory) lines.push(`  directory: ${session.directory}`)
  lines.push(`  last event: ${new Date(session.lastEventAt).toISOString()} (${ageSeconds}s ago)`)
  if (detail.children.length) {
    lines.push(`children: ${detail.children.length}`)
    for (const child of detail.children) {
      lines.push(`- ${child.sessionID.slice(0, 12)} ${child.status}${child.agent ? ` agent=${child.agent}` : ""}`)
    }
  }
  if (detail.claims.length) {
    lines.push(`claims: ${detail.claims.length} active`)
    for (const claim of detail.claims) {
      lines.push(`- ${claim.claimID} ${claim.agent} expires=${claim.expires}`)
    }
  }
  if (detail.todos.length) {
    const active = detail.todos.filter((todo) => todo.status === "in_progress").length
    lines.push(`todos: ${active} in progress / ${detail.todos.length} total`)
    for (const todo of detail.todos.slice(-10)) {
      lines.push(`- [${todo.status}] ${todo.content.slice(0, 100)}`)
    }
  }
  if (detail.commands.length) {
    lines.push(`recent commands: ${detail.commands.length}`)
    for (const command of detail.commands.slice(-10)) {
      const category = toStringValue(command.refs?.category) ?? ""
      lines.push(`- ${new Date(command.ts).toISOString()} ${category} ${command.summary ?? ""}`.trimEnd())
    }
  }
  if (detail.risks.length) {
    lines.push(`risks: ${detail.risks.length}`)
    for (const risk of detail.risks.slice(-5)) {
      lines.push(`- ${risk.category}: ${risk.summary}`)
    }
  }
  if (detail.messages.length) {
    lines.push(`messages (last ${detail.messages.length}):`)
    for (const message of detail.messages) {
      const who = [message.role, message.agent, message.model].filter(Boolean).join(" ")
      lines.push(`- ${who}: ${message.text}`)
    }
  }
  return lines.join("\n")
}

const server: Plugin = async (input, options) => {
  const cfg = resolveOptions(options)
  const serverID = `${SERVER_ID}-${Math.random().toString(16).slice(2, 10)}`
  const now = () => Date.now()

  let hubDir: string | undefined
  let log: EventLog | undefined
  let initialization: Promise<{ hubDir: string; log: EventLog }> | undefined
  const sessions = new Map<string, SessionNode>()
  const comms = new Map<string, CommsPointer>()
  const repoRootCache = new Map<string, string | undefined>()
  let identityBaseCache: string | undefined
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined

  const ensure = async (): Promise<{ hubDir: string; log: EventLog }> => {
    if (hubDir && log) return { hubDir, log }
    initialization ??= (async () => {
      const stateDir = await resolveStateDir(input, cfg.storageDir)
      const projectID = toStringValue(input.project?.id) ?? "unknown"
      const dir = hubRoot(stateDir, projectID)
      mkdirSync(dir, { recursive: true })
      const eventLog = new EventLog(dir, serverID, cfg.retentionBytes)
      for (const record of readEventRecords(dir, { maxAgeMs: cfg.maxAgeMs })) {
        applyRecord(sessions, record)
        applyCommsRecord(comms, record)
      }
      hubDir = dir
      log = eventLog
      return { hubDir: dir, log: eventLog }
    })()
    return initialization
  }

  const repoRootFor = (directory: string): string | undefined => {
    if (repoRootCache.has(directory)) return repoRootCache.get(directory)
    const root = findRepoRoot(directory)
    repoRootCache.set(directory, root)
    return root
  }

  const append = async (record: EventRecord): Promise<void> => {
    const { log: eventLog } = await ensure()
    eventLog.append(record)
    applyRecord(sessions, record)
    applyCommsRecord(comms, record)
    scheduleSnapshot()
  }

  const writeSnapshot = async (): Promise<void> => {
    const { hubDir: dir } = await ensure()
    const target = snapshotFile(dir)
    const temporary = `${target}.${serverID}.tmp`
    const payload = {
      generatedAt: now(),
      serverID,
      sessions: [...sessions.values()],
    }
    try {
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      renameSync(temporary, target)
    } catch {
      // snapshot is a convenience; the event log remains authoritative
    }
  }

  const scheduleSnapshot = (): void => {
    if (snapshotTimer) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined
      void writeSnapshot()
    }, 500)
    if (typeof snapshotTimer === "object" && "unref" in snapshotTimer) {
      snapshotTimer.unref()
    }
  }

  const sessionClient = input.client as unknown as {
    session: {
      list: () => Promise<unknown>
      status: () => Promise<unknown>
      todo: (input: { path: { id: string } }) => Promise<unknown>
      messages: (input: { path: { id: string }; query?: { limit?: number } }) => Promise<unknown>
      prompt: (input: {
        path: { id: string }
        body: { parts: Array<{ type: "text"; text: string }>; noReply?: boolean; messageID?: string }
      }) => Promise<unknown>
    }
  }

  const SEND_CAP = 5
  const SEND_CAP_WINDOW_MS = 60_000
  const sendTimes = new Map<string, number[]>()
  let syntheticPartCounter = 0

  const syntheticPartID = (): string => {
    syntheticPartCounter = syntheticPartCounter % 1296
    syntheticPartCounter += 1
    return `prt_${Date.now().toString(36)}${syntheticPartCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }

  const injectInbox = async (
    sessionID: string,
    messageID: string | undefined,
    output: { message: { id: string }; parts: unknown[] },
  ): Promise<void> => {
    if (!cfg.injectComms) return
    await ensure()
    const pending = [...comms.values()]
      .filter((pointer) => pointer.to === sessionID && pointer.state === "sent")
      .sort((a, b) => a.ts - b.ts)
    if (!pending.length) return
    const fresh = inboxFor(pending, sessionID, { now: now() })
    if (!fresh.length) return
    const block = buildInboxBlock(
      fresh.map((pointer) => ({
        msgID: pointer.msgID,
        from: pointer.from,
        summary: pointer.summary,
        ts: pointer.ts,
        kind: pointer.kind,
      })),
    )
    if (!block) return
    output.parts.push({
      id: syntheticPartID(),
      sessionID,
      messageID: messageID ?? output.message.id,
      type: "text",
      text: block.text,
      synthetic: true,
      time: { start: now() },
    })
    for (const msgID of block.msgIDs) {
      await append({
        ts: now(),
        serverID,
        sessionID,
        kind: "comms.delivered",
        refs: { msgID },
      })
    }
  }

  const seedBaseline = async (): Promise<void> => {
    try {
      const listing = unwrap<SessionInfo[]>(await sessionClient.session.list())
      if (!Array.isArray(listing)) return
      let statuses: Record<string, SessionStatusInfo> = {}
      try {
        statuses = unwrap<Record<string, SessionStatusInfo>>(await sessionClient.session.status()) ?? {}
      } catch {
        statuses = {}
      }
      const cutoff = now() - cfg.maxAgeMs
      const candidates = listing
        .filter((session): session is SessionInfo & { id: string } => Boolean(session?.id))
        .filter((session) => !input.project?.id || !session.projectID || session.projectID === input.project.id)
        .filter((session) => !session.time?.updated || session.time.updated >= cutoff)
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
        .slice(0, BASELINE_LIMIT)

      for (const session of candidates) {
        const node = sessions.get(session.id)
        const costChanged = typeof session.cost === "number" && node?.cost !== session.cost
        if (!node || (session.title && node.title !== session.title) || costChanged) {
          await append({
            ts: now(),
            serverID,
            sessionID: session.id,
            parentID: session.parentID,
            kind: "session.updated",
            refs: {
              title: session.title ?? null,
              directory: session.directory ?? null,
              parentID: session.parentID ?? null,
              cost: typeof session.cost === "number" && Number.isFinite(session.cost) ? session.cost : null,
            },
          })
        }
        const status = statuses[session.id]?.type
        const current = sessions.get(session.id)
        if (
          status &&
          (status === "idle" || status === "busy" || status === "retry" || status === "error") &&
          current &&
          current.status !== status
        ) {
          await append({ ts: now(), serverID, sessionID: session.id, kind: "session.status", refs: { status } })
        }
      }
    } catch {
      // baseline import is best-effort; the live event tap still runs
    }
  }

  const safeTodos = async (sessionID: string): Promise<SessionDetail["todos"]> => {
    try {
      const rows = unwrap<Array<{ content?: string; status?: string }>>(
        await sessionClient.session.todo({ path: { id: sessionID } }),
      )
      if (!Array.isArray(rows)) return []
      return rows
        .filter((row) => typeof row?.content === "string")
        .map((row) => ({ content: String(row.content), status: String(row.status ?? "unknown") }))
    } catch {
      return []
    }
  }

  const safeMessages = async (sessionID: string, limit: number): Promise<SessionDetail["messages"]> => {
    try {
      const rows = unwrap<MessageRow[]>(
        await sessionClient.session.messages({ path: { id: sessionID }, query: { limit } }),
      )
      if (!Array.isArray(rows)) return []
      return rows.slice(-limit).map((row) => {
        const info = asRecord(row.info)
        return {
          role: toStringValue(info.role) ?? "?",
          agent: toStringValue(info.agent),
          model: toStringValue(info.modelID),
          text: summarizeParts(row.parts),
        }
      })
    } catch {
      return []
    }
  }

  const buildDetail = async (
    dir: string,
    state: MonitorState,
    ref: string,
    messages: number | undefined,
  ): Promise<SessionDetail | undefined> => {
    let node = pickSession(state.sessions, ref)
    if (!node) {
      try {
        const listing = unwrap<SessionInfo[]>(await sessionClient.session.list())
        const live = Array.isArray(listing) ? listing : []
        const match = live.find((session) => session.id === ref) ?? live.find((session) => session.id?.startsWith(ref))
        if (match?.id) {
          node = {
            sessionID: match.id,
            parentID: match.parentID,
            kind: match.parentID ? "subagent" : "root",
            title: match.title,
            directory: match.directory,
            status: "unknown",
            lastEventAt: match.time?.updated ?? now(),
          }
        }
      } catch {
        // fall through to undefined
      }
    }
    if (!node) return undefined

    const records = readEventRecords(dir, { now: now(), maxAgeMs: cfg.maxAgeMs })
    const limit = Math.min(Math.max(messages ?? 0, 0), MESSAGE_LIMIT)
    return {
      session: node,
      children: state.sessions.filter((session) => session.parentID === node.sessionID),
      claims: node.identity
        ? state.registry.claims.filter((claim) => claim.status === "active" && claim.agent === node.identity)
        : [],
      commands: records.filter((record) => record.sessionID === node.sessionID && record.kind === "command"),
      risks: state.risks.filter((risk) => risk.sessionID === node.sessionID),
      todos: await safeTodos(node.sessionID),
      messages: limit > 0 ? await safeMessages(node.sessionID, limit) : [],
    }
  }

  const identityBase = async (repoRoot: string): Promise<string> => {
    if (identityBaseCache) return identityBaseCache
    const name = await gitUserName(input.$ as unknown as ShellRunner | undefined, repoRoot)
    const host = hostname()
    identityBaseCache = `${name || "agent"}@${host || "host"}`
    return identityBaseCache
  }

  const identityFor = async (repoRoot: string, sessionID: string | undefined): Promise<string | undefined> => {
    if (!sessionID) return undefined
    const base = await identityBase(repoRoot)
    if (!base) return undefined
    const node = sessions.get(sessionID)
    return agentIdentity(base, sessionID, !!node?.parentID)
  }

  const stagedPaths = async (repoRoot: string): Promise<string[]> => {
    const shell = input.$ as unknown as ShellRunner | undefined
    if (!shell) return []
    try {
      const text = await shell`git -C ${repoRoot} diff --cached --name-only -z`.quiet().nothrow().text()
      return text
        .split("\0")
        .map((value) => value.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  const recordCoverageRisk = async (
    repoRoot: string,
    sessionID: string | undefined,
    category: string,
  ): Promise<void> => {
    if (!cfg.injectIdentity || !sessionID) return
    const identity = await identityFor(repoRoot, sessionID)
    if (!identity) return
    const paths = await stagedPaths(repoRoot)
    if (!paths.length) return
    const registry = buildRegistryState(repoRoot, now())
    const errors = coverageErrors(identity, registry.claims, paths, readAdoptionPaths(repoRoot), now())
    if (!errors.length) return
    await append({
      ts: now(),
      serverID,
      sessionID,
      kind: "command.risk",
      summary: `${errors.length} uncovered staged path(s) for ${category}`,
      refs: { category, uncovered: errors.length, detail: errors[0]?.slice(0, 160) ?? null },
    })
  }

  const hooks: Hooks = {
    event: async ({ event }) => {
      try {
        const record = recordFor(serverID, event as { type: string; properties?: Record<string, unknown> }, now())
        if (!record) return
        await append(record)
      } catch {
        // monitoring must never break the host session
      }
    },

    "chat.message": async (messageInput, output) => {
      try {
        const agent = messageInput.agent
        if (agent) {
          await append({
            ts: now(),
            serverID,
            sessionID: messageInput.sessionID,
            kind: "session.agent",
            refs: { agent },
          })
        }
        await injectInbox(messageInput.sessionID, messageInput.messageID, output)
      } catch {
        // ignore
      }
    },

    "tool.execute.before": async (toolInput, output) => {
      try {
        if (toolInput.tool !== "bash") return
        const command = asRecord(output.args).command
        if (typeof command !== "string" || !command.trim()) return
        const category = categorizeCommand(command)
        await append({
          ts: now(),
          serverID,
          sessionID: toolInput.sessionID,
          kind: "command",
          summary: summarizeCommand(command),
          refs: { category, callID: toolInput.callID, source: "bash" },
        })
        if (category === "git-commit" || category === "git-push" || category === "coord") {
          const root = repoRootFor(input.worktree ?? input.directory)
          if (root && isCoordinationEnabled(root)) {
            await recordCoverageRisk(root, toolInput.sessionID, category)
          }
        }
      } catch {
        // ignore
      }
    },

    "shell.env": async (shellInput, output) => {
      try {
        if (!cfg.injectIdentity) return
        if (output.env.COORD_AGENT_ID || process.env.COORD_AGENT_ID) return
        const sessionID = shellInput.sessionID
        if (!sessionID) return
        const root = repoRootFor(input.worktree ?? input.directory)
        if (!root || !isCoordinationEnabled(root)) return
        const identity = await identityFor(root, sessionID)
        if (!identity) return
        output.env.COORD_AGENT_ID = identity
        if (sessions.get(sessionID)?.identity !== identity) {
          await append({
            ts: now(),
            serverID,
            sessionID,
            kind: "session.identity",
            refs: { identity },
          })
        }
      } catch {
        // ignore
      }
    },

    tool: {
      swarm_status: tool({
        description:
          "Swarm status: other opencode sessions/subagents in this project plus coordination claims and conflicts. Pass `session` (full id or unique prefix) for one session's detail, with optional `messages` count to include recent message excerpts. Pass `inbox: true` to pull messages addressed to the calling session (marks them seen).",
        args: {
          format: tool.schema.enum(["json", "text", "tree"]).optional(),
          session: tool.schema.string().optional(),
          messages: tool.schema.number().optional(),
          inbox: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const { hubDir: dir } = await ensure()
          const root = repoRootFor(context.worktree ?? context.directory ?? input.directory)
          const state = readMonitorState(dir, root, { now: now(), maxAgeMs: cfg.maxAgeMs })
          const format = args.format ?? "text"

          if (args.session) {
            const detail = await buildDetail(dir, state, args.session, args.messages)
            const metadata = {
              sessions: state.sessions.length,
              claims: state.registry.claims.length,
              ...(detail ? { children: detail.children.length, todos: detail.todos.length, messages: detail.messages.length } : {}),
            }
            if (!detail) {
              return {
                title: "subplug swarm_status",
                output: `no session matching ${args.session}`,
                metadata,
              }
            }
            if (format === "json") {
              return {
                title: `subplug session ${detail.session.sessionID}`,
                output: JSON.stringify(detail, null, 2),
                metadata,
              }
            }
            return {
              title: `subplug session ${detail.session.sessionID}`,
              output: renderSessionDetail(detail),
              metadata,
            }
          }

          const caller = typeof context.sessionID === "string" ? context.sessionID : undefined
          const inbox = args.inbox && caller ? inboxFor(state.comms, caller, { now: now() }) : []
          if (caller) {
            for (const pointer of inbox) {
              await append({
                ts: now(),
                serverID,
                sessionID: caller,
                kind: "comms.seen",
                refs: { msgID: pointer.msgID },
              })
            }
          }
          const metadata = {
            sessions: state.sessions.length,
            claims: state.registry.claims.length,
            ...(inbox.length ? { inbox: inbox.length } : {}),
          }

          if (format === "json") {
            return {
              title: "subplug swarm_status",
              output: JSON.stringify(args.inbox ? { ...state, inbox } : state, null, 2),
              metadata,
            }
          }
          if (format === "tree") {
            return {
              title: "subplug swarm_status",
              output: `${renderStatusTree(state.generatedAt, dir, root, state.sessions, state.registry)}${renderInbox(inbox)}`,
              metadata,
            }
          }
          return {
            title: "subplug swarm_status",
            output: `${renderStatus(state.generatedAt, dir, root, state.sessions, state.registry)}${renderInbox(inbox)}`,
            metadata,
          }
        },
      }),

      swarm_send: tool({
        description:
          "Send a message to another opencode session or subagent in this project (addressed only, no broadcast). The message is written as a durable user message in the target session; idle targets start a turn, busy targets are queued for the next step boundary. Records a metadata-only pointer in the hub. Pass `confirm: true` to send to a busy target.",
        args: {
          session: tool.schema.string().optional(),
          task_id: tool.schema.string().optional(),
          message: tool.schema.string(),
          confirm: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const ref = (args.session ?? args.task_id ?? "").trim()
          const text = args.message.trim()
          if (!ref || !text) {
            return {
              title: "subplug swarm_send",
              output: "swarm_send needs a target session/task_id and a non-empty message",
            }
          }
          const { hubDir: dir } = await ensure()
          const root = repoRootFor(context.worktree ?? context.directory ?? input.directory)
          const state = readMonitorState(dir, root, { now: now(), maxAgeMs: cfg.maxAgeMs })
          const resolution = resolveTargets(state.sessions, ref)
          if (resolution.kind === "none") {
            return { title: "subplug swarm_send", output: `no session matching ${ref}` }
          }
          if (resolution.kind === "ambiguous") {
            const candidates = resolution.candidates.map((candidate) => candidate.sessionID.slice(0, 12)).join(", ")
            return { title: "subplug swarm_send", output: `ambiguous target ${ref}: ${candidates}` }
          }
          const target = resolution.session
          if (target.deleted) {
            return { title: "subplug swarm_send", output: `session ${target.sessionID.slice(0, 12)} is deleted` }
          }
          if (target.sessionID === context.sessionID) {
            return { title: "subplug swarm_send", output: "refusing to send a message to the calling session" }
          }
          if (target.status === "busy" && !args.confirm) {
            return {
              title: "subplug swarm_send",
              output: `session ${target.sessionID.slice(0, 12)} is busy; pass confirm:true to queue anyway (consumed at the next step boundary, may interleave)`,
              metadata: { target: target.sessionID, busy: true },
            }
          }
          const sender = context.sessionID
          const recent = (sendTimes.get(sender) ?? []).filter((ts) => now() - ts < SEND_CAP_WINDOW_MS)
          if (recent.length >= SEND_CAP) {
            return {
              title: "subplug swarm_send",
              output: `send cap reached (${SEND_CAP}/minute); wait before sending again`,
            }
          }
          const msgID = `msg_${Math.random().toString(16).slice(2, 10)}${now().toString(16)}`
          const noReply = target.status !== "idle"
          try {
            await sessionClient.session.prompt({
              path: { id: target.sessionID },
              body: { messageID: msgID, noReply, parts: [{ type: "text", text }] },
            })
          } catch (error) {
            return { title: "subplug swarm_send", output: `send failed: ${summarizeError(error)}` }
          }
          recent.push(now())
          sendTimes.set(sender, recent)
          const from = sessions.get(sender)?.identity ?? sender
          await append({
            ts: now(),
            serverID,
            sessionID: target.sessionID,
            kind: "comms.sent",
            summary: messageSummary(text),
            refs: { msgID, to: target.sessionID, from, kind: "message", delivery: noReply ? "queue" : "prompt" },
          })
          return {
            title: "subplug swarm_send",
            output: `sent ${msgID} to ${target.sessionID.slice(0, 12)} (${target.status}, ${noReply ? "queued" : "prompted"})`,
            metadata: { target: target.sessionID, msgID, noReply },
          }
        },
      }),
    },
  }

  void (async () => {
    try {
      await ensure()
      await append({
        ts: now(),
        serverID,
        kind: "server.start",
        summary: "subplug server tap online",
        refs: { directory: input.directory, worktree: input.worktree },
      })
      if (!process.env.SUBPLUG_SKIP_BASELINE) await seedBaseline()
    } catch {
      // deferred bootstrap is best-effort; hooks still retry through ensure()
    }
  })()

  return hooks
}

function renderStatus(
  generatedAt: number,
  hubDir: string,
  repoRoot: string | undefined,
  sessions: SessionNode[],
  registry: RegistryState,
): string {
  const lines: string[] = []
  const roots = sessions.filter((session) => session.kind === "root")
  const subagents = sessions.filter((session) => session.kind === "subagent")
  lines.push(`subplug status @ ${new Date(generatedAt).toISOString()}`)
  lines.push(`hub: ${hubDir}`)
  lines.push(`repo: ${repoRoot ?? "(not a git repository)"}`)
  lines.push(`sessions: ${sessions.length} (roots ${roots.length}, subagents ${subagents.length})`)
  for (const session of sessions) {
    const prefix = session.kind === "subagent" ? "  [sub]" : "[root]"
    const parts = [
      `${prefix} ${session.sessionID.slice(0, 12)}`,
      session.deleted ? "deleted" : session.status,
    ]
    if (session.agent) parts.push(`agent=${session.agent}`)
    if (session.model) parts.push(`model=${session.model}`)
    if (session.title) parts.push(`"${session.title.slice(0, 48)}"`)
    if (session.parentID) parts.push(`parent=${session.parentID.slice(0, 12)}`)
    lines.push(`- ${parts.join(" ")}`)
  }
  const active = registry.claims.filter((claim) => claim.status === "active")
  lines.push(`claims: ${active.length} active of ${registry.claims.length} total`)
  for (const claim of active) {
    const baton = claim.scopes.baton ? ` baton=${claim.scopes.baton}` : ""
    lines.push(`- ${claim.claimID} ${claim.agent} expires=${claim.expires}${baton}`)
  }
  if (registry.conflicts.length) {
    lines.push(`conflicts: ${registry.conflicts.length}`)
    for (const conflict of registry.conflicts) {
      lines.push(`- ${conflict.a} / ${conflict.b}: ${conflict.reason}`)
    }
  }
  if (registry.lastPassingVerification) {
    lines.push(
      `last passing verification: ${registry.lastPassingVerification.commit.slice(0, 12)} (${registry.lastPassingVerification.scope}) by ${registry.lastPassingVerification.agent}`,
    )
  }
  if (registry.errors.length) {
    lines.push(`registry errors: ${registry.errors.length}`)
  }
  return lines.join("\n")
}

function renderInbox(inbox: CommsPointer[]): string {
  if (!inbox.length) return ""
  const lines = [`inbox: ${inbox.length} pending`]
  for (const pointer of inbox) {
    lines.push(
      `- ${pointer.msgID} from=${pointer.from} at=${new Date(pointer.ts).toISOString()}${pointer.kind ? ` kind=${pointer.kind}` : ""}: ${pointer.summary}`,
    )
  }
  return `\n${lines.join("\n")}`
}

function renderStatusTree(
  generatedAt: number,
  hubDir: string,
  repoRoot: string | undefined,
  sessions: SessionNode[],
  registry: RegistryState,
): string {
  const tree = buildSessionTree(sessions)
  const rows = flattenTree(tree, new Set())
  const lines: string[] = []
  lines.push(`subplug tree @ ${new Date(generatedAt).toISOString()}`)
  lines.push(`hub: ${hubDir}`)
  lines.push(`repo: ${repoRoot ?? "(not a git repository)"}`)
  lines.push(
    `sessions: ${sessions.length} (roots ${tree.roots.length}, subagents ${sessions.length - tree.roots.length})`,
  )
  for (const row of rows) {
    const session = row.session
    const indent = row.depth > 0 ? `${"  ".repeat(row.depth - 1)}└ ` : ""
    const parts: string[] = []
    if (session.deleted) parts.push("deleted")
    parts.push(session.status)
    if (row.orphan) parts.push("orphan")
    if (session.agent) parts.push(`agent=${session.agent}`)
    if (session.model) parts.push(`model=${session.model}`)
    if (typeof session.cost === "number" && session.cost > 0) parts.push(`cost=$${session.cost.toFixed(4)}`)
    if (session.title) parts.push(`"${session.title.slice(0, 48)}"`)
    lines.push(`- ${indent}${session.sessionID.slice(0, 12)} ${parts.join(" ")}`)
  }
  for (const root of tree.roots) {
    const rollup = rollupSubtree(sessions, root.session.sessionID)
    if (rollup.total <= 1 && rollup.cost === 0) continue
    const summary: string[] = [`${rollup.total} session${rollup.total === 1 ? "" : "s"}`]
    if (rollup.busy) summary.push(`${rollup.busy} busy`)
    if (rollup.retry) summary.push(`${rollup.retry} retry`)
    if (rollup.error) summary.push(`${rollup.error} err`)
    if (rollup.deleted) summary.push(`${rollup.deleted} deleted`)
    if (rollup.cost) summary.push(`cost=$${rollup.cost.toFixed(4)}`)
    lines.push(`subtree ${root.session.sessionID.slice(0, 12)}: ${summary.join(" ")}`)
  }
  const active = registry.claims.filter((claim) => claim.status === "active")
  lines.push(`claims: ${active.length} active of ${registry.claims.length} total`)
  for (const claim of active) {
    const baton = claim.scopes.baton ? ` baton=${claim.scopes.baton}` : ""
    lines.push(`- ${claim.claimID} ${claim.agent} expires=${claim.expires}${baton}`)
  }
  if (registry.conflicts.length) {
    lines.push(`conflicts: ${registry.conflicts.length}`)
    for (const conflict of registry.conflicts) {
      lines.push(`- ${conflict.a} / ${conflict.b}: ${conflict.reason}`)
    }
  }
  return lines.join("\n")
}

export default {
  id: "subplug",
  server,
}

export { renderStatus }
