import type { ClaimRecord, CommsPointer, EventRecord, RegistryState, RiskRecord, SessionNode } from "../shared/types.ts"
import { buildSessionTree, flattenTree, rollupSubtree } from "../hub/tree.ts"

export type DetailMessage = { role: string; agent?: string; model?: string; text: string }

export type SessionDetail = {
  session: SessionNode
  children: SessionNode[]
  claims: ClaimRecord[]
  commands: EventRecord[]
  risks: RiskRecord[]
  todos: Array<{ content: string; status: string }>
  messages: DetailMessage[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function pickSession(sessions: SessionNode[], ref: string): SessionNode | undefined {
  const value = ref.trim()
  if (!value) return undefined
  const exact = sessions.find((session) => session.sessionID === value)
  if (exact) return exact
  const matches = sessions.filter((session) => session.sessionID.startsWith(value))
  return matches.length === 1 ? matches[0] : undefined
}

/** Short transcript line from a v2 session context entry. */
export function summarizeContextMessage(message: Record<string, unknown>, maxChars = 240): DetailMessage | undefined {
  const type = toStringValue(message.type)
  if (!type) return undefined
  if (type === "assistant") {
    const pieces: string[] = []
    for (const entry of Array.isArray(message.content) ? message.content : []) {
      const content = asRecord(entry)
      if (content.type === "text" && typeof content.text === "string") {
        const text = content.text.replace(/\s+/g, " ").trim()
        if (text) pieces.push(text)
        continue
      }
      if (content.type === "tool" && typeof content.name === "string") {
        const status = toStringValue(asRecord(content.state).status) ?? ""
        pieces.push(`[tool ${content.name}${status ? ` ${status}` : ""}]`)
      }
    }
    const text = pieces.filter(Boolean).join(" ")
    return {
      role: "assistant",
      agent: toStringValue(message.agent),
      model: toStringValue(asRecord(message.model).id) ?? toStringValue(asRecord(message.model).modelID),
      text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text,
    }
  }
  if (type === "user" || type === "synthetic" || type === "system" || type === "skill") {
    const raw = typeof message.text === "string" ? message.text.replace(/\s+/g, " ").trim() : ""
    return { role: type, text: raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}…` : raw }
  }
  return undefined
}

export function renderSessionDetail(detail: SessionDetail): string {
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

export function renderStatus(
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

export function renderInbox(inbox: CommsPointer[]): string {
  if (!inbox.length) return ""
  const lines = [`inbox: ${inbox.length} pending`]
  for (const pointer of inbox) {
    lines.push(
      `- ${pointer.msgID} from=${pointer.from} at=${new Date(pointer.ts).toISOString()}${pointer.kind ? ` kind=${pointer.kind}` : ""}: ${pointer.summary}`,
    )
  }
  return `\n${lines.join("\n")}`
}

export function renderStatusTree(
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
