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
import { fallbackStateDir, hubRoot, snapshotFile } from "../hub/paths.ts"
import { findRepoRoot, isCoordinationEnabled } from "../coord/repo.ts"
import { buildRegistryState, coverageErrors, readAdoptionPaths } from "../coord/claims.ts"
import type { RegistryState } from "../shared/types.ts"

const SERVER_ID = "subplug"

type ShellPromise = {
  quiet(): ShellPromise
  nothrow(): ShellPromise
  text(encoding?: string): Promise<string>
}

type ShellRunner = (strings: TemplateStringsArray, ...expressions: unknown[]) => ShellPromise

type SubplugOptions = {
  injectIdentity: boolean
  storageDir?: string
  retentionBytes?: number
  maxAgeMs: number
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

function resolveOptions(options?: Record<string, unknown>): SubplugOptions {
  const root = asRecord(options)
  const coord = asRecord(root.coord)
  const envInject = toBool(process.env.SUBPLUG_INJECT_IDENTITY, false)
  const envStorage = toStringValue(process.env.SUBPLUG_STORAGE_DIR)
  return {
    injectIdentity: toBool(coord.injectIdentity, toBool(root.injectIdentity, envInject)),
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
      const refs: Record<string, string | null> = {
        title: toStringValue(info.title) ?? null,
        directory: toStringValue(info.directory) ?? null,
        parentID: toStringValue(info.parentID) ?? null,
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

const server: Plugin = async (input, options) => {
  const cfg = resolveOptions(options)
  const serverID = `${SERVER_ID}-${Math.random().toString(16).slice(2, 10)}`
  const now = () => Date.now()

  let hubDir: string | undefined
  let log: EventLog | undefined
  let initialization: Promise<{ hubDir: string; log: EventLog }> | undefined
  const sessions = new Map<string, SessionNode>()
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

    "chat.message": async (messageInput) => {
      try {
        const agent = messageInput.agent
        if (!agent) return
        await append({
          ts: now(),
          serverID,
          sessionID: messageInput.sessionID,
          kind: "session.agent",
          refs: { agent },
        })
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
          "Read-only swarm status: other opencode sessions/subagents in this project plus coordination claims and conflicts.",
        args: {
          format: tool.schema.enum(["json", "text"]).optional(),
        },
        async execute(args, context) {
          const { hubDir: dir } = await ensure()
          const root = repoRootFor(context.worktree ?? context.directory ?? input.directory)
          const state = readMonitorState(dir, root, { now: now(), maxAgeMs: cfg.maxAgeMs })
          const format = args.format ?? "text"
          if (format === "json") {
            return {
              title: "subplug swarm_status",
              output: JSON.stringify(state, null, 2),
              metadata: { sessions: state.sessions.length, claims: state.registry.claims.length },
            }
          }
          return {
            title: "subplug swarm_status",
            output: renderStatus(state.generatedAt, dir, root, state.sessions, state.registry),
            metadata: { sessions: state.sessions.length, claims: state.registry.claims.length },
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

export default {
  id: "subplug",
  server,
}

export { renderStatus }
