import type { EventRecord, SessionNode, SessionStatus } from "../shared/types.ts"

function statusFrom(value: unknown): SessionStatus {
  if (value === "idle" || value === "busy" || value === "retry" || value === "error") return value
  return "unknown"
}

function ensure(nodes: Map<string, SessionNode>, sessionID: string, ts: number, serverID: string): SessionNode {
  const existing = nodes.get(sessionID)
  if (existing) return existing
  const node: SessionNode = {
    sessionID,
    kind: "root",
    status: "unknown",
    lastEventAt: ts,
    serverID,
  }
  nodes.set(sessionID, node)
  return node
}

export function applyRecord(nodes: Map<string, SessionNode>, record: EventRecord): void {
  const ts = record.ts
  const refs = record.refs ?? {}

  const sessionID = record.sessionID
  switch (record.kind) {
    case "session.created":
    case "session.updated":
    case "session.deleted": {
      const id = sessionID ?? (typeof refs.sessionID === "string" ? refs.sessionID : undefined)
      if (!id) return
      const node = ensure(nodes, id, ts, record.serverID)
      node.lastEventAt = ts
      node.serverID = record.serverID
      if (typeof refs.title === "string" && refs.title) node.title = refs.title
      if (typeof refs.directory === "string" && refs.directory) node.directory = refs.directory
      if (record.parentID) node.parentID = record.parentID
      if (typeof refs.parentID === "string" && refs.parentID) node.parentID = refs.parentID
      if (typeof refs.cost === "number" && Number.isFinite(refs.cost)) node.cost = refs.cost
      if (record.kind === "session.created" && node.status === "unknown") node.status = "idle"
      if (record.kind === "session.deleted") node.deleted = true
      return
    }
    case "session.agent": {
      if (!sessionID) return
      const node = ensure(nodes, sessionID, ts, record.serverID)
      node.lastEventAt = ts
      if (typeof refs.agent === "string" && refs.agent) node.agent = refs.agent
      return
    }
    case "session.model": {
      if (!sessionID) return
      const node = ensure(nodes, sessionID, ts, record.serverID)
      node.lastEventAt = ts
      if (typeof refs.model === "string" && refs.model) node.model = refs.model
      return
    }
    case "session.identity": {
      if (!sessionID) return
      const node = ensure(nodes, sessionID, ts, record.serverID)
      node.lastEventAt = ts
      if (typeof refs.identity === "string" && refs.identity) node.identity = refs.identity
      return
    }
    case "session.status": {
      if (!sessionID) return
      const node = ensure(nodes, sessionID, ts, record.serverID)
      node.lastEventAt = ts
      node.status = statusFrom(refs.status)
      return
    }
    case "session.idle": {
      if (!sessionID) return
      const node = ensure(nodes, sessionID, ts, record.serverID)
      node.lastEventAt = ts
      node.status = "idle"
      return
    }
    case "session.error": {
      if (!sessionID) return
      const node = ensure(nodes, sessionID, ts, record.serverID)
      node.lastEventAt = ts
      node.status = "error"
      node.errorAt = ts
      return
    }
    default: {
      if (!sessionID) return
      const node = ensure(nodes, sessionID, ts, record.serverID)
      node.lastEventAt = ts
    }
  }
}

export function foldSessions(records: EventRecord[]): SessionNode[] {
  const nodes = new Map<string, SessionNode>()
  for (const record of records) applyRecord(nodes, record)
  for (const node of nodes.values()) node.kind = node.parentID ? "subagent" : "root"
  return [...nodes.values()].sort((a, b) => a.lastEventAt - b.lastEventAt)
}

export function sessionDepth(nodes: Map<string, SessionNode>, sessionID: string): number {
  let depth = 0
  let current = nodes.get(sessionID)
  const seen = new Set<string>()
  while (current?.parentID && !seen.has(current.parentID)) {
    seen.add(current.parentID)
    depth += 1
    current = nodes.get(current.parentID)
  }
  return depth
}
