import type { ClaimRecord, MonitorState, RegistryState, RiskRecord, SessionNode } from "../shared/types.ts"
import { buildRegistryState } from "../coord/claims.ts"
import { readEventRecords } from "./append.ts"
import { foldSessions } from "./fold.ts"

export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const MAX_RISKS = 20

export function emptyRegistry(): RegistryState {
  return { claims: [], verifications: [], conflicts: [], errors: [] }
}

function toRisks(records: ReturnType<typeof readEventRecords>): RiskRecord[] {
  const risks: RiskRecord[] = []
  for (const record of records) {
    if (record.kind !== "command.risk") continue
    risks.push({
      ts: record.ts,
      sessionID: record.sessionID,
      category: typeof record.refs?.category === "string" ? record.refs.category : "risk",
      summary: record.summary ?? "uncovered staged paths",
    })
  }
  return risks.slice(-MAX_RISKS)
}

export function readMonitorState(
  hubDir: string,
  repoRoot: string | undefined,
  options: { now?: number; maxAgeMs?: number } = {},
): MonitorState {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const records = readEventRecords(hubDir, { now, maxAgeMs })
  const registry = repoRoot ? buildRegistryState(repoRoot, now) : emptyRegistry()
  return {
    generatedAt: now,
    hubDir,
    sessions: foldSessions(records),
    risks: toRisks(records),
    registry,
  }
}

export type ClaimHolder = {
  claim: ClaimRecord
  session?: SessionNode
}

export function joinClaimsToSessions(
  registry: RegistryState,
  sessions: SessionNode[],
): ClaimHolder[] {
  const byIdentity = new Map<string, SessionNode>()
  for (const session of sessions) {
    if (session.identity) byIdentity.set(session.identity, session)
  }
  return registry.claims
    .filter((claim) => claim.status === "active")
    .map((claim) => ({ claim, session: byIdentity.get(claim.agent) }))
}
