import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog, readEventRecords } from "../src/hub/append.ts"
import { foldSessions, sessionDepth } from "../src/hub/fold.ts"
import { agentIdentity } from "../src/hub/identity.ts"
import { joinClaimsToSessions, readMonitorState } from "../src/hub/monitor.ts"
import { fallbackStateDir, hubRoot } from "../src/hub/paths.ts"
import type { EventRecord } from "../src/shared/types.ts"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subplug-hub-"))
}

function record(overrides: Partial<EventRecord> & { kind: EventRecord["kind"] }): EventRecord {
  return { ts: 1000, serverID: "srv1", ...overrides }
}

describe("EventLog", () => {
  test("appends JSONL records that replay after a restart", () => {
    const dir = tempDir()
    try {
      const log = new EventLog(dir, "srv1")
      log.append(record({ kind: "server.start" }))
      log.append(record({ ts: 2000, kind: "session.created", sessionID: "ses_1", refs: { title: "root" } }))
      const replayed = readEventRecords(dir)
      expect(replayed.length).toBe(2)
      expect(replayed[0]?.kind).toBe("server.start")
      expect(replayed[1]?.sessionID).toBe("ses_1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rotates a full log and keeps reading both segments", () => {
    const dir = tempDir()
    try {
      const log = new EventLog(dir, "srv1", 450)
      for (let index = 0; index < 10; index += 1) {
        log.append(record({ ts: 1000 + index, kind: "message", sessionID: "ses_1" }))
      }
      expect(existsSync(`${log.file()}.1`)).toBe(true)
      const replayed = readEventRecords(dir)
      expect(replayed.length).toBe(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("drops malformed lines instead of failing", () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, "events.srv1.jsonl"), "{ broken\n" + JSON.stringify(record({ kind: "message" })) + "\n")
      expect(readEventRecords(dir).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("older records are filtered by max age", () => {
    const dir = tempDir()
    try {
      const log = new EventLog(dir, "srv1")
      log.append(record({ ts: 1000, kind: "server.start" }))
      log.append(record({ ts: 10_000, kind: "session.idle", sessionID: "ses_1" }))
      expect(readEventRecords(dir, { now: 10_500, maxAgeMs: 2000 }).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("foldSessions", () => {
  test("builds parent/child trees with statuses", () => {
    const sessions = foldSessions([
      record({ ts: 1, kind: "session.created", sessionID: "root", refs: { title: "Root", directory: "/repo" } }),
      record({ ts: 2, kind: "session.agent", sessionID: "root", refs: { agent: "build" } }),
      record({ ts: 3, kind: "session.created", sessionID: "child", parentID: "root", refs: { title: "Child" } }),
      record({ ts: 4, kind: "session.status", sessionID: "child", refs: { status: "busy" } }),
      record({ ts: 5, kind: "session.status", sessionID: "root", refs: { status: "busy" } }),
      record({ ts: 6, kind: "session.idle", sessionID: "root" }),
      record({ ts: 7, kind: "session.error", sessionID: "child", summary: "ApiError" }),
    ])
    const byID = new Map(sessions.map((session) => [session.sessionID, session]))
    expect(byID.get("root")?.kind).toBe("root")
    expect(byID.get("root")?.status).toBe("idle")
    expect(byID.get("root")?.agent).toBe("build")
    expect(byID.get("child")?.kind).toBe("subagent")
    expect(byID.get("child")?.status).toBe("error")
    const nodes = new Map(sessions.map((session) => [session.sessionID, session]))
    expect(sessionDepth(nodes, "child")).toBe(1)
    expect(sessionDepth(nodes, "root")).toBe(0)
  })

  test("session.deleted marks the node", () => {
    const sessions = foldSessions([
      record({ ts: 1, kind: "session.created", sessionID: "root" }),
      record({ ts: 2, kind: "session.deleted", sessionID: "root" }),
    ])
    expect(sessions[0]?.deleted).toBe(true)
  })
})

describe("fallbackStateDir", () => {
  test("uses XDG_STATE_HOME when set", () => {
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = join(tmpdir(), "subplug-xdg")
    try {
      expect(fallbackStateDir()).toBe(join(tmpdir(), "subplug-xdg", "opencode"))
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })
})

describe("agentIdentity", () => {
  test("roots share the base identity while subagents are unique and stable", () => {
    expect(agentIdentity("name@host", "ses_aaaabbbb", false)).toBe("name@host")

    const first = agentIdentity("name@host", "ses_aaaabbbb", true)
    const second = agentIdentity("name@host", "ses_ccccdddd", true)
    expect(first).toBe("name@host/ses_aaaa")
    expect(second).toBe("name@host/ses_cccc")
    expect(first).not.toBe(second)
    expect(agentIdentity("name@host", "ses_aaaabbbb", true)).toBe(first)
  })
})

describe("readMonitorState", () => {
  test("merges hub sessions with the coordination registry", () => {
    const root = tempDir()
    try {
      const hubDir = hubRoot(root, "proj")
      const eventTime = Date.parse("2026-09-27T11:00:00Z")
      const log = new EventLog(hubDir, "srv1")
      log.append(record({ ts: eventTime, kind: "session.created", sessionID: "ses_1", refs: { title: "Root" } }))
      const claims = join(root, "coordination", "claims")
      mkdirSync(claims, { recursive: true })
      const event = {
        event_id: "e1",
        kind: "claim",
        agent: "a@host",
        issued: "2026-09-27T09:00:00Z",
        expires: "2026-09-28T09:00:00Z",
        claim_id: "claim-1",
        scopes: { patterns: [], files: ["src/app.py"], docs: [], evidence: [], baton: null },
      }
      writeFileSync(join(claims, "a.jsonl"), `${JSON.stringify(event)}\n`)

      const state = readMonitorState(hubDir, root, { now: Date.parse("2026-09-27T12:00:00Z") })
      expect(state.sessions.length).toBe(1)
      expect(state.registry.claims.length).toBe(1)
      expect(state.risks).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("extracts command.risk records and joins claims to sessions by identity", () => {
    const root = tempDir()
    try {
      const hubDir = hubRoot(root, "proj")
      const base = Date.parse("2026-09-27T11:00:00Z")
      const log = new EventLog(hubDir, "srv1")
      log.append(record({ ts: base, kind: "session.created", sessionID: "ses_1", refs: { title: "Root" } }))
      log.append(record({ ts: base + 1, kind: "session.identity", sessionID: "ses_1", refs: { identity: "a@host" } }))
      log.append(
        record({
          ts: base + 2,
          kind: "command.risk",
          sessionID: "ses_1",
          summary: "2 uncovered staged path(s) for git-commit",
          refs: { category: "git-commit", uncovered: 2 },
        }),
      )
      const claims = join(root, "coordination", "claims")
      mkdirSync(claims, { recursive: true })
      const event = {
        event_id: "e1",
        kind: "claim",
        agent: "a@host",
        issued: "2026-09-27T09:00:00Z",
        expires: "2026-09-28T09:00:00Z",
        claim_id: "claim-1",
        scopes: { patterns: [], files: ["src/app.py"], docs: [], evidence: [], baton: null },
      }
      writeFileSync(join(claims, "a.jsonl"), `${JSON.stringify(event)}\n`)

      const state = readMonitorState(hubDir, root, { now: Date.parse("2026-09-27T12:00:00Z") })
      expect(state.risks.length).toBe(1)
      expect(state.risks[0]?.category).toBe("git-commit")
      expect(state.sessions[0]?.identity).toBe("a@host")

      const joined = joinClaimsToSessions(state.registry, state.sessions)
      expect(joined.length).toBe(1)
      expect(joined[0]?.session?.sessionID).toBe("ses_1")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
