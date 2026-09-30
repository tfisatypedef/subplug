import { spawnSync } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { Plugin } from "@opencode/plugin"
import { categorizeCommand, summarizeCommand, summarizeError } from "../shared/redact.ts"
import type { CommsPointer, EventRecord, SessionNode } from "../shared/types.ts"
import { EventLog, EventTail, readEventRecords, readSessionRecords } from "../hub/append.ts"
import { applyRecord } from "../hub/fold.ts"
import { agentIdentity } from "../hub/identity.ts"
import { readMonitorState } from "../hub/monitor.ts"
import { applyCommsRecord, buildInboxBlock, inboxFor, resolveTargets } from "../hub/comms.ts"
import { FollowUpConfirmationRequired, followUpError, sendFollowUp, type FollowUpTransport } from "../shared/follow-up.ts"
import { fallbackStateDir, hubRoot, snapshotFile, writeHubPointer } from "../hub/paths.ts"
import { findRepoRoot, isCoordinationEnabled } from "../coord/repo.ts"
import { enforceLeases, relativeLeasePath, toolLeasePaths } from "../coord/leases.ts"
import { buildRegistryState, coverageErrors, readAdoptionPaths } from "../coord/claims.ts"
import { startWebServer, type WebTranscript } from "./web.ts"
import {
  pickSession,
  renderInbox,
  renderSessionDetail,
  renderStatus,
  renderStatusTree,
  summarizeContextMessage,
  type SessionDetail,
} from "./render.ts"

const SERVER_ID = "subplug"
const SEND_CAP = 5
const SEND_CAP_WINDOW_MS = 60_000
const MESSAGE_LIMIT = 50

export type EventEnvelope = { type: string; data?: Record<string, unknown> }

export type WorkResult = { content?: string; metadata?: Record<string, unknown> }

export type ToolExecuteContext = {
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
}

export type ToolDefinition = {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: Record<string, unknown>, context: ToolExecuteContext) => Promise<WorkResult> | WorkResult
  options?: { codemode?: boolean; pinned?: boolean }
}

export type ToolEditor = { add: (tool: ToolDefinition) => void }

export type ToolEnvelope = {
  tool: string
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
  input?: Record<string, unknown>
}

export type SessionPromptEnvelope = {
  sessionID?: string
  messageID?: string
  prompt: { text: string }
  delivery?: string
}

export type ServerContext = {
  readonly options?: unknown
  readonly location: {
    readonly directory?: string
    readonly project?: { readonly id?: string }
  }
  readonly event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<EventEnvelope>
  }
  readonly tool: {
    transform: (callback: (editor: ToolEditor) => void) => Promise<unknown>
    hook: (
      name: "execute.before" | "execute.after",
      callback: (event: ToolEnvelope) => Promise<void> | void,
    ) => Promise<unknown>
  }
  readonly session: {
    hook: (name: "prompt", callback: (event: SessionPromptEnvelope) => Promise<void> | void) => Promise<unknown>
    get: (input: { sessionID: string }) => Promise<unknown>
    context: (input: { sessionID: string }) => Promise<unknown>
    prompt: (input: {
      sessionID: string
      text: string
      delivery?: "steer" | "queue"
      resume?: boolean
      id?: string
    }) => Promise<unknown>
  }
}

export type SubplugOptions = {
  injectComms: boolean
  storageDir?: string
  hubGroup?: string
  retentionBytes?: number
  maxAgeMs: number
  web: { enabled: boolean; port: number; token?: string }
}

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

function locationDirectory(value: unknown): string | undefined {
  if (typeof value === "string") return toStringValue(value)
  return toStringValue(asRecord(value).directory)
}

function modelLabel(value: unknown): string | undefined {
  const record = asRecord(value)
  return toStringValue(record.id) ?? toStringValue(record.modelID)
}

export function resolveOptions(options?: unknown): SubplugOptions {
  const root = asRecord(options)
  const coord = asRecord(root.coord)
  const comms = asRecord(root.comms)
  const web = asRecord(root.web)
  const envStorage = toStringValue(process.env.SUBPLUG_STORAGE_DIR)
  return {
    injectComms: toBool(comms.inject, toBool(root.injectComms, true)),
    storageDir: toStringValue(coord.storageDir) ?? toStringValue(root.storageDir) ?? envStorage,
    hubGroup:
      toStringValue(coord.hubGroup) ??
      toStringValue(root.hubGroup) ??
      toStringValue(process.env.SUBPLUG_HUB_GROUP),
    retentionBytes: toNumber(coord.retentionBytes) ?? toNumber(root.retentionBytes),
    maxAgeMs: toNumber(coord.maxAgeMs) ?? toNumber(root.maxAgeMs) ?? 24 * 60 * 60 * 1000,
    web: {
      enabled: toBool(web.enabled, false),
      port: toNumber(web.port) ?? 7690,
      token: toStringValue(web.token),
    },
  }
}

export function recordFor(serverID: string, event: EventEnvelope, now: number): EventRecord | undefined {
  const data = asRecord(event.data)
  const sessionID = toStringValue(data.sessionID)
  switch (event.type) {
    case "session.created": {
      if (!sessionID) return undefined
      return {
        ts: now,
        serverID,
        sessionID,
        parentID: toStringValue(data.parentID),
        kind: "session.created",
        refs: {
          title: toStringValue(data.title) ?? null,
          directory: locationDirectory(data.location) ?? null,
          parentID: toStringValue(data.parentID) ?? null,
          agent: toStringValue(data.agent) ?? null,
          model: modelLabel(data.model) ?? null,
        },
      }
    }
    case "session.renamed": {
      if (!sessionID) return undefined
      return {
        ts: now,
        serverID,
        sessionID,
        kind: "session.updated",
        refs: { title: toStringValue(data.title) ?? null },
      }
    }
    case "session.agent.selected": {
      if (!sessionID) return undefined
      const agent = toStringValue(data.agent)
      if (!agent) return undefined
      return { ts: now, serverID, sessionID, kind: "session.agent", refs: { agent } }
    }
    case "session.model.selected": {
      if (!sessionID) return undefined
      const model = modelLabel(data.model)
      if (!model) return undefined
      return { ts: now, serverID, sessionID, kind: "session.model", refs: { model } }
    }
    case "session.usage.updated": {
      if (!sessionID) return undefined
      const cost = toNumber(data.cost)
      if (cost === undefined) return undefined
      return { ts: now, serverID, sessionID, kind: "session.updated", refs: { cost } }
    }
    case "session.deleted": {
      if (!sessionID) return undefined
      return { ts: now, serverID, sessionID, kind: "session.deleted" }
    }
    case "session.execution.started": {
      if (!sessionID) return undefined
      return { ts: now, serverID, sessionID, kind: "session.status", refs: { status: "busy" } }
    }
    case "session.execution.succeeded":
    case "session.execution.interrupted": {
      if (!sessionID) return undefined
      return { ts: now, serverID, sessionID, kind: "session.idle" }
    }
    case "session.execution.failed":
    case "session.step.failed": {
      if (!sessionID) return undefined
      return { ts: now, serverID, sessionID, kind: "session.error", summary: summarizeError(data.error) }
    }
    case "session.retry.scheduled": {
      if (!sessionID) return undefined
      return { ts: now, serverID, sessionID, kind: "session.status", refs: { status: "retry" } }
    }
    case "session.status": {
      if (!sessionID) return undefined
      const status = toStringValue(asRecord(data.status).type)
      if (status === "idle") return { ts: now, serverID, sessionID, kind: "session.idle" }
      if (status === "busy" || status === "retry") {
        return { ts: now, serverID, sessionID, kind: "session.status", refs: { status } }
      }
      return undefined
    }
    case "session.idle": {
      if (!sessionID) return undefined
      return { ts: now, serverID, sessionID, kind: "session.idle" }
    }
    default:
      return undefined
  }
}

function gitUserName(repoRoot: string): string {
  try {
    const result = spawnSync("git", ["-C", repoRoot, "config", "user.name"], {
      encoding: "utf8",
      timeout: 2000,
    })
    return result.status === 0 ? (result.stdout ?? "").trim() : ""
  } catch {
    return ""
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function setupServer(ctx: ServerContext): Promise<() => void> {
  const cfg = resolveOptions(ctx.options)
  const serverID = `${SERVER_ID}-${Math.random().toString(16).slice(2, 10)}`
  const now = () => Date.now()
  const directory = toStringValue(ctx.location?.directory) ?? process.cwd()
  const projectID = toStringValue(ctx.location?.project?.id) ?? "unknown"
  const stateDir = cfg.storageDir ?? fallbackStateDir()
  const dir = hubRoot(stateDir, cfg.hubGroup ?? projectID)
  mkdirSync(dir, { recursive: true })
  try {
    writeHubPointer({ hubDir: dir, group: cfg.hubGroup ?? projectID, at: now() })
  } catch {
    // the pointer is a convenience for the TUI entry, which cannot see these options
  }

  const log = new EventLog(dir, serverID, cfg.retentionBytes)
  const sessions = new Map<string, SessionNode>()
  const comms = new Map<string, CommsPointer>()
  const commsTail = new EventTail()
  commsTail.seed(dir)
  // Age applies to a session's activity, not each field's provenance: an active
  // child still needs yesterday's parent/title/identity after log rotation.
  for (const record of readSessionRecords(dir)) applyRecord(sessions, record)
  for (const [id, session] of sessions) {
    if (now() - session.lastEventAt > cfg.maxAgeMs) sessions.delete(id)
  }
  for (const record of readEventRecords(dir, { maxAgeMs: cfg.maxAgeMs })) {
    applyCommsRecord(comms, record)
  }

  const repoRootCache = new Map<string, string | undefined>()
  const identityBaseCache = new Map<string, string>()
  const identityChecked = new Set<string>()
  const sendTimes = new Map<string, Array<{ ts: number }>>()
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined

  const repoRootFor = (start: string): string | undefined => {
    if (repoRootCache.has(start)) return repoRootCache.get(start)
    const root = findRepoRoot(start)
    repoRootCache.set(start, root)
    return root
  }

  const writeSnapshot = (): void => {
    const target = snapshotFile(dir)
    const temporary = `${target}.${serverID}.tmp`
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ generatedAt: now(), serverID, sessions: [...sessions.values()] }, null, 2)}\n`,
        "utf8",
      )
      renameSync(temporary, target)
    } catch {
      // snapshot is a convenience; the event log remains authoritative
    }
  }

  const scheduleSnapshot = (): void => {
    if (snapshotTimer) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined
      writeSnapshot()
    }, 500)
    if (typeof snapshotTimer === "object" && "unref" in snapshotTimer) snapshotTimer.unref()
  }

  const append = (record: EventRecord): void => {
    log.append(record)
    applyRecord(sessions, record)
    applyCommsRecord(comms, record)
    scheduleSnapshot()
  }

  const identityBaseFor = (root: string): string => {
    const cached = identityBaseCache.get(root)
    if (cached) return cached
    const base = `${gitUserName(root) || "agent"}@${hostname() || "host"}`
    identityBaseCache.set(root, base)
    return base
  }

  const identityFor = (root: string, sessionID: string | undefined): string | undefined => {
    if (!sessionID) return undefined
    return agentIdentity(identityBaseFor(root), sessionID)
  }

  const appendIdentity = (sessionID: string): void => {
    if (identityChecked.has(sessionID)) return
    identityChecked.add(sessionID)
    const node = sessions.get(sessionID)
    const root = repoRootFor(node?.directory ?? directory)
    if (!root || !isCoordinationEnabled(root)) return
    const identity = identityFor(root, sessionID)
    if (!identity || sessions.get(sessionID)?.identity === identity) return
    append({ ts: now(), serverID, sessionID, kind: "session.identity", refs: { identity } })
  }

  const stagedPaths = (root: string): string[] => {
    const result = spawnSync("git", ["-C", root, "diff", "--cached", "--name-only", "-z"], {
      encoding: "utf8",
      timeout: 5000,
    })
    if (result.status !== 0) return []
    return (result.stdout ?? "")
      .split("\0")
      .map((value) => value.trim())
      .filter(Boolean)
  }

  const recordCoverageRisk = (root: string, sessionID: string | undefined, category: string): void => {
    if (!sessionID) return
    const identity = identityFor(root, sessionID)
    if (!identity) return
    const paths = stagedPaths(root)
    if (!paths.length) return
    const registry = buildRegistryState(root, now())
    const errors = coverageErrors(identity, registry.claims, paths, readAdoptionPaths(root), now())
    if (!errors.length) return
    append({
      ts: now(),
      serverID,
      sessionID,
      kind: "command.risk",
      summary: `${errors.length} uncovered staged path(s) for ${category}`,
      refs: { category, uncovered: errors.length, detail: errors[0]?.slice(0, 160) ?? null },
    })
  }

  const enforceEditLeases = async (
    tool: string,
    args: Record<string, unknown>,
    sessionID: string | undefined,
  ): Promise<void> => {
    const root = repoRootFor(directory)
    if (!root || !isCoordinationEnabled(root)) return
    const paths = toolLeasePaths(tool, args)
      .map((path) => relativeLeasePath(root, path))
      .filter((path): path is string => Boolean(path))
    if (!paths.length) return
    const holder = identityFor(root, sessionID)
    if (!holder) return
    await enforceLeases({ repoRoot: root, holder, sessionID: sessionID ?? "unknown", pid: process.pid, paths })
  }

  const followUpTransport: FollowUpTransport = {
    get: (sessionID) => ctx.session.get({ sessionID }),
    prompt: (request) => ctx.session.prompt(request),
  }

  const transcript = async (sessionID: string, limit: number): Promise<SessionDetail["messages"]> => {
    try {
      const rows = await ctx.session.context({ sessionID })
      if (!Array.isArray(rows)) return []
      return rows
        .slice(-limit)
        .map((row) => summarizeContextMessage(asRecord(row)))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
    } catch {
      return []
    }
  }

  const buildDetail = async (
    dirPath: string,
    state: ReturnType<typeof readMonitorState>,
    ref: string,
    messages: number | undefined,
  ): Promise<SessionDetail | undefined> => {
    let node = pickSession(state.sessions, ref)
    if (!node) {
      try {
        const info = asRecord(await ctx.session.get({ sessionID: ref }))
        const id = toStringValue(info.id)
        if (id) {
          node = {
            sessionID: id,
            parentID: toStringValue(info.parentID),
            kind: info.parentID ? "subagent" : "root",
            title: toStringValue(info.title),
            directory: locationDirectory(info.location),
            status: "unknown",
            lastEventAt: now(),
          }
        }
      } catch {
        // fall through to undefined
      }
    }
    if (!node) return undefined

    const records = readEventRecords(dirPath, { maxAgeMs: cfg.maxAgeMs })
    const limit = Math.min(Math.max(messages ?? 0, 0), MESSAGE_LIMIT)
    return {
      session: node,
      children: state.sessions.filter((session) => session.parentID === node.sessionID),
      claims: node.identity
        ? state.registry.claims.filter((claim) => claim.status === "active" && claim.agent === node.identity)
        : [],
      commands: records.filter((record) => record.sessionID === node.sessionID && record.kind === "command"),
      risks: state.risks.filter((risk) => risk.sessionID === node.sessionID),
      todos: [],
      messages: limit > 0 ? await transcript(node.sessionID, limit) : [],
    }
  }

  const injectInbox = (event: SessionPromptEnvelope): void => {
    if (!cfg.injectComms) return
    const sessionID = toStringValue(event.sessionID)
    if (!sessionID) return
    for (const record of commsTail.read(dir)) applyCommsRecord(comms, record)
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
    const current = typeof event.prompt?.text === "string" ? event.prompt.text : ""
    event.prompt.text = current ? `${current}\n\n${block.text}` : block.text
    for (const msgID of block.msgIDs) {
      append({ ts: now(), serverID, sessionID, kind: "comms.delivered", refs: { msgID } })
    }
  }

  const webTranscript = async (sessionID: string): Promise<WebTranscript | undefined> => {
    let known = sessions.has(sessionID)
    if (!known) {
      try {
        const info = asRecord(await ctx.session.get({ sessionID }))
        known = Boolean(toStringValue(info.id))
      } catch {
        known = false
      }
    }
    if (!known) return undefined
    return { sessionID, messages: await transcript(sessionID, MESSAGE_LIMIT) }
  }

  let web: { stop: () => void } | undefined
  if (cfg.web.enabled) {
    const started = startWebServer(
      {
        state: () => readMonitorState(dir, repoRootFor(directory), { now: now(), maxAgeMs: cfg.maxAgeMs }),
        transcript: webTranscript,
        token: cfg.web.token,
      },
      { port: cfg.web.port },
    )
    if ("error" in started) {
      process.stderr.write(`[subplug] web view failed on port ${cfg.web.port}: ${started.error}\n`)
    } else {
      web = started
      process.stderr.write(`[subplug] web view on http://127.0.0.1:${started.port}\n`)
    }
  }

  append({
    ts: now(),
    serverID,
    kind: "server.start",
    summary: "subplug server tap online",
    refs: { directory },
  })

  await ctx.session.hook("prompt", (event) => {
    try {
      injectInbox(event)
    } catch {
      // inbox injection must never break the host session
    }
  })

  await ctx.tool.hook("execute.before", async (event) => {
    // A lease denial must escape this hook; keep it outside the monitoring
    // catch below so a thrown conflict actually blocks the tool call.
    const args = asRecord(event.input)
    await enforceEditLeases(event.tool, args, event.sessionID)
    try {
      if (event.tool !== "bash") return
      const command = args.command
      if (typeof command !== "string" || !command.trim()) return
      const category = categorizeCommand(command)
      append({
        ts: now(),
        serverID,
        sessionID: event.sessionID,
        kind: "command",
        summary: summarizeCommand(command),
        refs: { category, callID: event.id ?? null, source: "bash" },
      })
      const root = repoRootFor(directory)
      if (root && isCoordinationEnabled(root)) {
        if (category === "git-commit" || category === "git-push" || category === "coord") {
          recordCoverageRisk(root, event.sessionID, category)
        }
        const identity = identityFor(root, event.sessionID)
        if (identity) {
          args.command = `export COORD_AGENT_ID=${shellQuote(identity)}; ${command}`
          if (event.sessionID && sessions.get(event.sessionID)?.identity !== identity) {
            append({ ts: now(), serverID, sessionID: event.sessionID, kind: "session.identity", refs: { identity } })
          }
        }
      }
    } catch {
      // monitoring must never break the host session
    }
  })

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "swarm_status",
      description:
        "Swarm status: other opencode sessions/subagents in this project plus coordination claims and conflicts. Pass `session` (full id or unique prefix) for one session's detail, with optional `messages` count to include recent message excerpts. Pass `inbox: true` to pull messages addressed to the calling session (marks them seen).",
      input: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["json", "text", "tree"] },
          session: { type: "string" },
          messages: { type: "number" },
          inbox: { type: "boolean" },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const state = readMonitorState(dir, repoRootFor(directory), { now: now(), maxAgeMs: cfg.maxAgeMs })
        const format = toStringValue(args.format) ?? "text"

        if (toStringValue(args.session)) {
          const detail = await buildDetail(dir, state, String(args.session), toNumber(args.messages))
          const metadata = {
            sessions: state.sessions.length,
            claims: state.registry.claims.length,
            ...(detail
              ? { children: detail.children.length, todos: detail.todos.length, messages: detail.messages.length }
              : {}),
          }
          if (!detail) {
            return { content: `no session matching ${String(args.session)}`, metadata }
          }
          if (format === "json") {
            return { content: JSON.stringify(detail, null, 2), metadata }
          }
          return { content: renderSessionDetail(detail), metadata }
        }

        const caller = toStringValue(context.sessionID)
        const inbox = args.inbox && caller ? inboxFor(state.comms, caller, { now: now() }) : []
        if (caller) {
          for (const pointer of inbox) {
            append({ ts: now(), serverID, sessionID: caller, kind: "comms.seen", refs: { msgID: pointer.msgID } })
          }
        }
        const metadata = {
          sessions: state.sessions.length,
          claims: state.registry.claims.length,
          ...(inbox.length ? { inbox: inbox.length } : {}),
        }

        if (format === "json") {
          return { content: JSON.stringify(args.inbox ? { ...state, inbox } : state, null, 2), metadata }
        }
        if (format === "tree") {
          return {
            content: `${renderStatusTree(state.generatedAt, dir, repoRootFor(directory), state.sessions, state.registry)}${renderInbox(inbox)}`,
            metadata,
          }
        }
        return {
          content: `${renderStatus(state.generatedAt, dir, repoRootFor(directory), state.sessions, state.registry)}${renderInbox(inbox)}`,
          metadata,
        }
      },
    })

    editor.add({
      name: "swarm_send",
      description:
        "Send follow-up context to another opencode agent or subagent in this project (addressed only, no broadcast). The full text stays in the target's native session: idle agents resume without waiting for their response; running agents receive it at their next step. Records a metadata-only inbox pointer. Pass `confirm: true` to queue for a running target.",
      input: {
        type: "object",
        properties: {
          session: { type: "string" },
          task_id: { type: "string" },
          message: { type: "string" },
          confirm: { type: "boolean" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const ref = (toStringValue(args.session) ?? toStringValue(args.task_id) ?? "").trim()
        const text = toStringValue(args.message)
        if (!ref || !text || typeof args.message !== "string") {
          return { content: "swarm_send needs a target session/task_id and a non-empty message" }
        }
        const state = readMonitorState(dir, repoRootFor(directory), { now: now(), maxAgeMs: cfg.maxAgeMs })
        const resolution = resolveTargets(state.sessions, ref)
        if (resolution.kind === "none") {
          return { content: `no session matching ${ref}` }
        }
        if (resolution.kind === "ambiguous") {
          const candidates = resolution.candidates.map((candidate) => candidate.sessionID.slice(0, 12)).join(", ")
          return { content: `ambiguous target ${ref}: ${candidates}` }
        }
        const target = resolution.session
        if (target.deleted) {
          return { content: `session ${target.sessionID.slice(0, 12)} is deleted` }
        }
        const sender = toStringValue(context.sessionID)
        if (sender && target.sessionID === sender) {
          return { content: "refusing to send a message to the calling session" }
        }
        const capKey = sender ?? "unknown"
        const recent = (sendTimes.get(capKey) ?? []).filter((entry) => now() - entry.ts < SEND_CAP_WINDOW_MS)
        if (recent.length >= SEND_CAP) {
          return { content: `send cap reached (${SEND_CAP}/minute); wait before sending again` }
        }
        const reservation = { ts: now() }
        recent.push(reservation)
        sendTimes.set(capKey, recent)
        let sent: Awaited<ReturnType<typeof sendFollowUp>>
        try {
          sent = await sendFollowUp({
            target,
            status: target.status,
            message: text,
            from: (sender ? sessions.get(sender)?.identity : undefined) ?? sender ?? "unknown",
            serverID,
            confirm: args.confirm === true,
            transport: followUpTransport,
            record: append,
          })
        } catch (error) {
          // Remove only this send's reservation; parallel successes retain theirs.
          sendTimes.set(capKey, (sendTimes.get(capKey) ?? []).filter((entry) => entry !== reservation))
          if (error instanceof FollowUpConfirmationRequired) {
            return {
              content: `session ${target.sessionID.slice(0, 12)} is ${error.status}; pass confirm:true to queue follow-up context for its next step`,
              metadata: { target: target.sessionID, busy: true },
            }
          }
          return { content: `send failed: ${followUpError(error)}` }
        }
        return {
          content: `sent ${sent.msgID} to ${target.sessionID.slice(0, 12)} (${sent.status}, ${sent.noReply ? "queued" : "prompted"})`,
          metadata: { target: target.sessionID, msgID: sent.msgID, noReply: sent.noReply },
        }
      },
    })
  })

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const record = recordFor(serverID, event, now())
          if (!record) continue
          append(record)
          if (record.kind === "session.created" || record.kind === "session.status") {
            if (record.sessionID) appendIdentity(record.sessionID)
          }
        } catch {
          // monitoring must never break the host session
        }
      }
    } catch {
      // the subscription ends when the host shuts down
    }
  })()

  return () => {
    controller.abort()
    web?.stop()
    web = undefined
    if (snapshotTimer) {
      clearTimeout(snapshotTimer)
      snapshotTimer = undefined
    }
  }
}

export const server = Plugin.define({
  id: "subplug",
  setup: (ctx) => setupServer(ctx as unknown as ServerContext),
})

export default server

export { renderStatus } from "./render.ts"
