import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  ClaimConflict,
  ClaimRecord,
  ClaimScopes,
  RegistryState,
  VerificationRecord,
} from "../shared/types.ts"
import { globMatch } from "./glob.ts"

export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
export const EVENT_KINDS = new Set(["claim", "renew", "release", "verification"])
export const BATONS = new Set(["planning", "verify", "adoption"])
const PLANNING_EXACT = new Set(["plans/README.md"])
const PLANNING_PREFIXES = ["plans/workstreams/"]
const ADOPTION_EXTRA = ["tools/plant.py", "plans/.plant-lock.json"]
const EXEMPT_EXACT = new Set(["README.md"])
const EXEMPT_PREFIXES = ["coordination/", ".venv/", "node_modules/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/"]
const EXEMPT_SEGMENTS = new Set(["__pycache__"])

export type RegistryEvent = Record<string, unknown>

export function utcNow(): number {
  return Date.now()
}

export function formatTimestamp(moment: number): string {
  return new Date(moment).toISOString().replace(/\.\d{3}Z$/, "Z")
}

export function parseTimestamp(value: string): number | undefined {
  if (!TIMESTAMP_PATTERN.test(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
}

export function isExempt(path: string): boolean {
  const normalized = normalizePath(path)
  if (EXEMPT_EXACT.has(normalized)) return true
  if (EXEMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  return normalized.split("/").some((segment) => EXEMPT_SEGMENTS.has(segment))
}

export function isPlanningPath(path: string): boolean {
  const normalized = normalizePath(path)
  if (PLANNING_EXACT.has(normalized)) return true
  return PLANNING_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export function readAdoptionPaths(repoRoot: string): Set<string> {
  const paths = new Set<string>()
  const lockFile = join(repoRoot, "plans", ".plant-lock.json")
  try {
    const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { files?: Record<string, unknown> }
    if (lock && typeof lock.files === "object" && lock.files) {
      for (const key of Object.keys(lock.files)) paths.add(`plans/${normalizePath(key)}`)
    }
  } catch {
    // no installed Plant snapshot; the fixed extras still apply
  }
  for (const extra of ADOPTION_EXTRA) paths.add(extra)
  return paths
}

export function isAdoptionPath(adoptionPaths: Set<string>, path: string): boolean {
  return adoptionPaths.has(normalizePath(path))
}

export function requiredBatons(adoptionPaths: Set<string>, path: string): string[] {
  const batons: string[] = []
  if (isPlanningPath(path)) batons.push("planning")
  if (isAdoptionPath(adoptionPaths, path)) batons.push("adoption")
  return batons
}

function underPrefix(path: string, prefix: string): boolean {
  const foldedPath = normalizePath(path).toLowerCase()
  const foldedPrefix = normalizePath(prefix).toLowerCase()
  return foldedPath === foldedPrefix || foldedPath.startsWith(`${foldedPrefix}/`)
}

function validateTimestampField(event: RegistryEvent, field: string): string | undefined {
  const value = event[field]
  if (typeof value !== "string" || !value) return `${field} must be a non-empty timestamp`
  if (parseTimestamp(value) === undefined) return `invalid timestamp: ${JSON.stringify(value)}`
  return undefined
}

export function validateEvent(event: RegistryEvent): string | undefined {
  for (const field of ["event_id", "kind", "agent", "issued"]) {
    if (typeof event[field] !== "string" || !event[field]) {
      return `event field '${field}' must be a non-empty string`
    }
  }
  const issuedError = validateTimestampField(event, "issued")
  if (issuedError) return issuedError
  const kind = String(event.kind)
  if (!EVENT_KINDS.has(kind)) return `unsupported event kind: ${kind}`
  if (kind === "claim") return validateClaimEvent(event)
  if (kind === "renew" || kind === "release") return validateLifecycleEvent(event, kind)
  return validateVerificationEvent(event)
}

function validateClaimEvent(event: RegistryEvent): string | undefined {
  if (typeof event.claim_id !== "string" || !event.claim_id) return "claim event requires a claim_id"
  if (!event.scopes || typeof event.scopes !== "object" || Array.isArray(event.scopes)) {
    return "claim event requires a scopes object"
  }
  const expiresError = validateTimestampField(event, "expires")
  if (expiresError) return `claim event: ${expiresError}`
  const baton = (event.scopes as Record<string, unknown>).baton
  if (baton !== null && baton !== undefined && (typeof baton !== "string" || !BATONS.has(baton))) {
    return `unsupported baton: ${String(baton)}`
  }
  return undefined
}

function validateLifecycleEvent(event: RegistryEvent, kind: string): string | undefined {
  if (typeof event.claim_id !== "string" || !event.claim_id) return `${kind} event requires a claim_id`
  if (kind === "renew") {
    const expiresError = validateTimestampField(event, "expires")
    if (expiresError) return `renew event: ${expiresError}`
  }
  return undefined
}

function validateVerificationEvent(event: RegistryEvent): string | undefined {
  if (event.result !== "passed" && event.result !== "failed") {
    return "verification event requires result passed or failed"
  }
  if (typeof event.commit !== "string" || !event.commit) return "verification event requires a commit"
  if (event.scope !== "full" && event.scope !== "targeted") {
    return "verification event requires scope full or targeted"
  }
  return undefined
}

function parseScopes(event: RegistryEvent): ClaimScopes {
  const raw = event.scopes
  const scopes: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item)) : [])
  const baton = scopes.baton
  return {
    patterns: list(scopes.patterns),
    files: list(scopes.files),
    docs: list(scopes.docs),
    evidence: list(scopes.evidence),
    baton: typeof baton === "string" ? baton : null,
  }
}

export function readEvents(claimsDir: string): { events: RegistryEvent[]; errors: string[] } {
  const errors: string[] = []
  if (!existsSync(claimsDir)) return { events: [], errors }
  let names: string[]
  try {
    names = readdirSync(claimsDir)
  } catch (error) {
    return { events: [], errors: [`${claimsDir}: cannot read claim logs: ${String(error)}`] }
  }

  const byID = new Map<string, RegistryEvent>()
  for (const name of names.filter((item) => item.endsWith(".jsonl")).sort()) {
    const file = join(claimsDir, name)
    let lines: string[]
    try {
      lines = readFileSync(file, "utf8").split(/\r?\n/)
    } catch (error) {
      errors.push(`${file}: cannot read claim log: ${String(error)}`)
      continue
    }
    lines.forEach((line, index) => {
      if (!line.trim()) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        errors.push(`${file}:${index + 1}: invalid JSON event: ${String(error)}`)
        return
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push(`${file}:${index + 1}: event must be a JSON object`)
        return
      }
      const event = parsed as RegistryEvent
      const validation = validateEvent(event)
      if (validation) {
        errors.push(`${file}:${index + 1}: ${validation}`)
        return
      }
      const eventID = String(event.event_id)
      const previous = byID.get(eventID)
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
        errors.push(`${file}:${index + 1}: event_id ${eventID} redefined with different content`)
        return
      }
      byID.set(eventID, event)
    })
  }

  const events = [...byID.values()].sort((a, b) => {
    const issued = String(a.issued).localeCompare(String(b.issued))
    if (issued !== 0) return issued
    return String(a.event_id).localeCompare(String(b.event_id))
  })
  return { events, errors }
}

export function foldEvents(events: RegistryEvent[]): {
  claims: Map<string, ClaimRecord>
  verifications: VerificationRecord[]
  errors: string[]
} {
  const errors: string[] = []
  const claims = new Map<string, ClaimRecord>()

  for (const event of events) {
    if (event.kind !== "claim") continue
    const claimID = String(event.claim_id)
    if (claims.has(claimID)) {
      errors.push(`duplicate claim id: ${claimID}`)
      continue
    }
    claims.set(claimID, {
      claimID,
      agent: String(event.agent),
      status: "active",
      issued: String(event.issued),
      expires: String(event.expires),
      note: typeof event.note === "string" ? event.note : "",
      takenOverFrom: typeof event.taken_over_from === "string" ? event.taken_over_from : undefined,
      scopes: parseScopes(event),
    })
  }

  for (const event of events) {
    if (event.kind !== "claim" || !event.taken_over_from) continue
    const replaced = claims.get(String(event.taken_over_from))
    if (!replaced) {
      errors.push(`takeover references unknown claim ${String(event.taken_over_from)}`)
    } else if (replaced.status !== "active") {
      errors.push(`takeover target ${replaced.claimID} is already ${replaced.status}`)
    } else {
      replaced.status = "taken_over"
    }
  }

  const verifications: VerificationRecord[] = []
  for (const event of events) {
    if (event.kind === "verification") {
      verifications.push({
        agent: String(event.agent),
        issued: String(event.issued),
        commit: String(event.commit),
        result: event.result === "passed" ? "passed" : "failed",
        scope: event.scope === "full" ? "full" : "targeted",
        commands: Array.isArray(event.commands) ? event.commands.map((item) => String(item)) : [],
        note: typeof event.note === "string" ? event.note : "",
      })
      continue
    }
    if (event.kind === "renew" || event.kind === "release") {
      const claim = claims.get(String(event.claim_id))
      if (!claim) {
        errors.push(`${String(event.kind)} references unknown claim ${String(event.claim_id)}`)
        continue
      }
      if (claim.agent !== event.agent) {
        errors.push(`${String(event.kind)} of ${claim.claimID} must come from ${claim.agent}`)
        continue
      }
      if (event.kind === "renew") {
        claim.expires = String(event.expires)
      } else {
        claim.status = "released"
      }
    }
  }

  return { claims, verifications, errors }
}

export function isExpired(claim: ClaimRecord, now: number): boolean {
  if (claim.status !== "active") return false
  const expires = parseTimestamp(claim.expires)
  return expires !== undefined && expires < now
}

export function activeClaims(claims: Map<string, ClaimRecord>, now: number): ClaimRecord[] {
  return [...claims.values()].filter((claim) => claim.status === "active" && !isExpired(claim, now))
}

function batonConflict(first: ClaimRecord, second: ClaimRecord, adoptionPaths: Set<string>): string | undefined {
  if (first.scopes.baton && first.scopes.baton === second.scopes.baton) {
    return `both hold baton ${first.scopes.baton}`
  }
  for (const [holder, other] of [
    [first, second],
    [second, first],
  ] as const) {
    if (holder.scopes.baton === "planning") {
      const clash = other.scopes.files.find((path) => isPlanningPath(path))
      if (clash) return `planning baton conflicts with ${other.claimID} (${clash})`
    }
    if (holder.scopes.baton === "adoption") {
      const clash = other.scopes.files.find((path) => isAdoptionPath(adoptionPaths, path))
      if (clash) return `adoption baton conflicts with ${other.claimID} (${clash})`
    }
  }
  return undefined
}

function fileConflict(first: ClaimRecord, second: ClaimRecord): string | undefined {
  const shared = new Set(first.scopes.files.map((path) => path.toLowerCase()))
  for (const path of second.scopes.files) {
    if (shared.has(path.toLowerCase())) return `shared path ${path}`
  }
  const docs = new Set(first.scopes.docs.map((doc) => doc.toUpperCase()))
  for (const doc of second.scopes.docs) {
    if (docs.has(doc.toUpperCase())) return `shared document ${doc.toUpperCase()}`
  }
  return undefined
}

function evidenceConflict(first: ClaimRecord, second: ClaimRecord): string | undefined {
  for (const left of first.scopes.evidence) {
    for (const right of second.scopes.evidence) {
      if (underPrefix(left, right) || underPrefix(right, left)) {
        return `shared evidence scope ${left} / ${right}`
      }
    }
  }
  for (const path of first.scopes.files) {
    for (const prefix of second.scopes.evidence) {
      if (underPrefix(path, prefix)) return `${path} falls under evidence scope ${prefix}`
    }
  }
  for (const path of second.scopes.files) {
    for (const prefix of first.scopes.evidence) {
      if (underPrefix(path, prefix)) return `${path} falls under evidence scope ${prefix}`
    }
  }
  return undefined
}

export function conflictReason(
  first: ClaimRecord,
  second: ClaimRecord,
  adoptionPaths: Set<string>,
): string | undefined {
  return batonConflict(first, second, adoptionPaths) ?? fileConflict(first, second) ?? evidenceConflict(first, second)
}

export function conflictingClaims(
  claims: Map<string, ClaimRecord>,
  now: number,
  adoptionPaths: Set<string>,
): ClaimConflict[] {
  const active = activeClaims(claims, now)
  const conflicts: ClaimConflict[] = []
  for (let index = 0; index < active.length; index += 1) {
    for (let other = index + 1; other < active.length; other += 1) {
      const first = active[index]!
      const second = active[other]!
      const reason = conflictReason(first, second, adoptionPaths)
      if (reason) conflicts.push({ a: first.claimID, b: second.claimID, reason })
    }
  }
  return conflicts
}

export function claimCovers(claim: ClaimRecord, path: string, adoptionPaths: Set<string>): boolean {
  const folded = normalizePath(path).toLowerCase()
  if (claim.scopes.files.some((value) => value.toLowerCase() === folded)) return true
  if (claim.scopes.patterns.some((pattern) => globMatch(folded, pattern))) return true
  if (claim.scopes.baton === "planning" && isPlanningPath(path)) return true
  if (claim.scopes.baton === "adoption" && isAdoptionPath(adoptionPaths, path)) return true
  return claim.scopes.evidence.some((prefix) => underPrefix(path, prefix))
}

export function coverageErrors(
  agent: string,
  claims: ClaimRecord[],
  paths: string[],
  adoptionPaths: Set<string>,
  now: number = utcNow(),
): string[] {
  const held = claims.filter((claim) => claim.status === "active" && !isExpired(claim, now))
  const mine = held.filter((claim) => claim.agent === agent)
  const errors: string[] = []
  for (const path of paths) {
    if (isExempt(path)) continue
    const covering = held.filter((claim) => claimCovers(claim, path, adoptionPaths))
    if (!covering.some((claim) => claim.agent === agent)) {
      const owners = [...new Set(covering.map((claim) => claim.agent))].sort()
      const detail = owners.length ? ` (covered by ${owners.join(", ")})` : ""
      errors.push(`${path}: no active claim of ${agent} covers this path${detail}`)
    }
    for (const baton of requiredBatons(adoptionPaths, path)) {
      if (!mine.some((claim) => claim.scopes.baton === baton)) {
        errors.push(`${path}: requires active ${baton} baton held by ${agent}`)
      }
    }
  }
  return errors
}

export function lastVerification(
  verifications: VerificationRecord[],
  passedOnly = false,
): VerificationRecord | undefined {
  let best: VerificationRecord | undefined
  for (const record of verifications) {
    if (passedOnly && record.result !== "passed") continue
    if (!best || record.issued > best.issued) best = record
  }
  return best
}

export function claimsDir(repoRoot: string): string {
  return join(repoRoot, "coordination", "claims")
}

export function buildRegistryState(repoRoot: string, now: number = utcNow()): RegistryState {
  const adoptionPaths = readAdoptionPaths(repoRoot)
  const { events, errors } = readEvents(claimsDir(repoRoot))
  const folded = foldEvents(events)
  const conflicts = conflictingClaims(folded.claims, now, adoptionPaths)
  return {
    claims: [...folded.claims.values()].sort((a, b) => a.issued.localeCompare(b.issued)),
    verifications: folded.verifications,
    conflicts,
    errors: [...errors, ...folded.errors],
    lastPassingVerification: lastVerification(folded.verifications, true),
  }
}

export { ADOPTION_EXTRA }
