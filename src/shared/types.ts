export type EventKind =
  | "server.start"
  | "server.stop"
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.status"
  | "session.idle"
  | "session.error"
  | "session.agent"
  | "session.model"
  | "session.identity"
  | "message"
  | "todo.updated"
  | "command"
  | "command.risk"
  | "tool"
  | "registry"

export type EventRefs = Record<string, string | number | boolean | null>

export type EventRecord = {
  ts: number
  serverID: string
  sessionID?: string
  parentID?: string
  kind: EventKind
  summary?: string
  refs?: EventRefs
}

export type SessionKind = "root" | "subagent"
export type SessionStatus = "idle" | "busy" | "retry" | "error" | "unknown"

export type SessionNode = {
  sessionID: string
  parentID?: string
  kind: SessionKind
  agent?: string
  model?: string
  identity?: string
  title?: string
  directory?: string
  status: SessionStatus
  errorAt?: number
  deleted?: boolean
  serverID?: string
  cost?: number
  lastEventAt: number
}

export type CommandCategory =
  | "git-commit"
  | "git-push"
  | "coord"
  | "plant"
  | "test"
  | "other"

export type ClaimScopes = {
  patterns: string[]
  files: string[]
  docs: string[]
  evidence: string[]
  baton: string | null
}

export type ClaimStatus = "active" | "released" | "taken_over"

export type ClaimRecord = {
  claimID: string
  agent: string
  status: ClaimStatus
  issued: string
  expires: string
  note: string
  takenOverFrom?: string
  scopes: ClaimScopes
}

export type VerificationRecord = {
  agent: string
  issued: string
  commit: string
  result: "passed" | "failed"
  scope: "full" | "targeted"
  commands: string[]
  note: string
}

export type ClaimConflict = {
  a: string
  b: string
  reason: string
}

export type RegistryState = {
  claims: ClaimRecord[]
  verifications: VerificationRecord[]
  conflicts: ClaimConflict[]
  errors: string[]
  lastPassingVerification?: VerificationRecord
}

export type RiskRecord = {
  ts: number
  sessionID?: string
  category: string
  summary: string
}

export type MonitorState = {
  generatedAt: number
  hubDir: string
  sessions: SessionNode[]
  risks: RiskRecord[]
  recentCommands: EventRecord[]
  registry: RegistryState
}
