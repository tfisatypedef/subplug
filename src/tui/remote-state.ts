import type { MonitorState, SessionNode, SessionStatus } from "../shared/types.ts"
import type { TuiContextLike } from "./context.ts"
import type { V2SessionInfo } from "./data.ts"

export const REMOTE_SERVER_ID = "remote"

/** `data.session.status` only reports idle/running; the hub has more states. */
function remoteStatus(value: "idle" | "running" | undefined): SessionStatus {
  if (value === "running") return "busy"
  if (value === "idle") return "idle"
  return "unknown"
}

/**
 * Map `ctx.data.session.list()` rows into the hub's `SessionNode` shape. No
 * identity is available on a remote attach, so claims cannot join and the
 * registry stays empty.
 */
export function mapRemoteSessions(
  sessions: readonly V2SessionInfo[],
  lookup: {
    status: (sessionID: string) => "idle" | "running"
    cost?: (sessionID: string) => number
  },
  now = Date.now(),
): SessionNode[] {
  const nodes: SessionNode[] = []
  for (const session of sessions) {
    const sessionID = typeof session.id === "string" ? session.id : undefined
    if (!sessionID) continue
    const parentID = typeof session.parentID === "string" && session.parentID ? session.parentID : undefined

    let status: "idle" | "running" | undefined
    try {
      status = lookup.status(sessionID)
    } catch {
      status = undefined
    }

    let cost: number | undefined
    if (typeof lookup.cost === "function") {
      try {
        const value = lookup.cost(sessionID)
        if (typeof value === "number" && Number.isFinite(value)) cost = value
      } catch {
        // fall back to the listed cost below
      }
    }
    if (cost === undefined && typeof session.cost === "number" && Number.isFinite(session.cost)) {
      cost = session.cost
    }

    const updated = session.time?.updated
    nodes.push({
      sessionID,
      parentID,
      kind: parentID ? "subagent" : "root",
      agent: session.agent,
      model: session.model?.id,
      title: session.title,
      directory: session.location?.directory,
      status: remoteStatus(status),
      cost,
      serverID: REMOTE_SERVER_ID,
      lastEventAt: typeof updated === "number" && Number.isFinite(updated) ? updated : now,
    })
  }
  return nodes.sort((left, right) => left.lastEventAt - right.lastEventAt)
}

/**
 * Build a hub-free `MonitorState` from the attached server's live data. Risks,
 * commands, comms and the claim registry are unavailable on a remote attach.
 */
export function readRemoteState(ctx: TuiContextLike, now = Date.now()): MonitorState {
  const sessions = ctx.data.session.list() ?? []
  return {
    generatedAt: now,
    hubDir: "",
    source: "remote",
    sessions: mapRemoteSessions(
      sessions,
      {
        status: (sessionID) => ctx.data.session.status(sessionID),
        cost: ctx.data.session.cost?.bind(ctx.data.session),
      },
      now,
    ),
    risks: [],
    recentCommands: [],
    comms: [],
    registry: { claims: [], verifications: [], conflicts: [], errors: [] },
  }
}
