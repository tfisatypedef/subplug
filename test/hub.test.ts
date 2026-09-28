import { describe, expect, test } from "bun:test"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog, EventTail, readEventRecords } from "../src/hub/append.ts"
import { foldSessions, sessionDepth } from "../src/hub/fold.ts"
import { inboxFor } from "../src/hub/comms.ts"
import { agentIdentity } from "../src/hub/identity.ts"
import { joinClaimsToSessions, lastCommandBySession, readMonitorState } from "../src/hub/monitor.ts"
import { fallbackStateDir, hubRoot, sanitizeProjectID } from "../src/hub/paths.ts"
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

describe("EventTail", () => {
  test("reads existing records then only appended bytes", () => {
    const dir = tempDir()
    try {
      const log = new EventLog(dir, "srv1")
      log.append(record({ kind: "server.start" }))
      log.append(record({ ts: 2, kind: "session.idle", sessionID: "ses_1" }))

      const tail = new EventTail()
      expect(tail.read(dir).map((item) => item.kind)).toEqual(["server.start", "session.idle"])

      log.append(record({ ts: 3, kind: "session.agent", sessionID: "ses_1" }))
      expect(tail.read(dir).map((item) => item.kind)).toEqual(["session.agent"])
      expect(tail.read(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("seed skips records that were already replayed", () => {
    const dir = tempDir()
    try {
      const log = new EventLog(dir, "srv1")
      log.append(record({ kind: "server.start" }))

      const tail = new EventTail()
      tail.seed(dir)
      expect(tail.read(dir)).toEqual([])

      log.append(record({ ts: 2, kind: "session.idle", sessionID: "ses_1" }))
      expect(tail.read(dir).map((item) => item.kind)).toEqual(["session.idle"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("holds a partial trailing line until it is completed", () => {
    const dir = tempDir()
    try {
      const file = join(dir, "events.srv1.jsonl")
      writeFileSync(file, JSON.stringify(record({ kind: "server.start" })))

      const tail = new EventTail()
      expect(tail.read(dir)).toEqual([])

      appendFileSync(file, "\n")
      expect(tail.read(dir).map((item) => item.kind)).toEqual(["server.start"])
      expect(tail.read(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resets after the file shrinks", () => {
    const dir = tempDir()
    try {
      const file = join(dir, "events.srv1.jsonl")
      const log = new EventLog(dir, "srv1")
      log.append(record({ kind: "server.start" }))
      log.append(record({ ts: 2, kind: "session.idle", sessionID: "ses_1" }))

      const tail = new EventTail()
      expect(tail.read(dir).length).toBe(2)

      writeFileSync(file, `${JSON.stringify(record({ ts: 3, kind: "session.agent", sessionID: "ses_1" }))}\n`)
      expect(tail.read(dir).map((item) => item.ts)).toEqual([3])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resets after the file is replaced", () => {
    const dir = tempDir()
    try {
      const file = join(dir, "events.srv1.jsonl")
      const log = new EventLog(dir, "srv1")
      log.append(record({ kind: "server.start" }))

      const tail = new EventTail()
      expect(tail.read(dir).length).toBe(1)

      const replacement = join(dir, "replacement.jsonl")
      writeFileSync(
        replacement,
        `${JSON.stringify(record({ ts: 2, kind: "session.idle", sessionID: "ses_1", summary: "replaced" }))}\n`,
      )
      renameSync(replacement, file)
      expect(tail.read(dir)).toEqual([record({ ts: 2, kind: "session.idle", sessionID: "ses_1", summary: "replaced" })])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("readEventRecords limit", () => {
  test("keeps the globally newest records across files", () => {
    const dir = tempDir()
    try {
      const first = new EventLog(dir, "srv-a")
      first.append(record({ ts: 100, serverID: "srv-a", kind: "session.idle", sessionID: "ses_a" }))
      first.append(record({ ts: 400, serverID: "srv-a", kind: "session.idle", sessionID: "ses_a" }))
      const second = new EventLog(dir, "srv-b")
      second.append(record({ ts: 200, serverID: "srv-b", kind: "session.idle", sessionID: "ses_b" }))
      second.append(record({ ts: 300, serverID: "srv-b", kind: "session.idle", sessionID: "ses_b" }))

      expect(readEventRecords(dir, { maxRecords: 2 }).map((item) => item.ts)).toEqual([300, 400])
      expect(readEventRecords(dir, { maxRecords: 3 }).map((item) => item.ts)).toEqual([200, 300, 400])
      expect(readEventRecords(dir, { maxRecords: 0 })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("breaks equal timestamps by append order", () => {
    const dir = tempDir()
    try {
      const log = new EventLog(dir, "srv-a")
      for (const summary of ["first", "second", "third"]) {
        log.append(record({ ts: 500, kind: "session.idle", sessionID: "ses_a", summary }))
      }
      expect(readEventRecords(dir, { maxRecords: 2 }).map((item) => item.summary)).toEqual(["second", "third"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cross-server merge", () => {
  test("folds multiple server logs into one timeline", () => {
    const dir = tempDir()
    try {
      const first = new EventLog(dir, "srv-a")
      const second = new EventLog(dir, "srv-b")
      first.append(
        record({ ts: 1000, serverID: "srv-a", kind: "session.created", sessionID: "ses_a", refs: { title: "from a" } }),
      )
      second.append(
        record({ ts: 2000, serverID: "srv-b", kind: "session.created", sessionID: "ses_b", refs: { title: "from b" } }),
      )
      second.append(
        record({ ts: 3000, serverID: "srv-b", kind: "session.identity", sessionID: "ses_b", refs: { identity: "b@host" } }),
      )

      const replayed = readEventRecords(dir)
      expect(replayed.map((item) => item.ts)).toEqual([1000, 2000, 3000])
      expect(replayed.map((item) => item.serverID)).toEqual(["srv-a", "srv-b", "srv-b"])

      const state = readMonitorState(dir, undefined, { now: 4000 })
      expect(state.sessions.map((session) => session.sessionID).sort()).toEqual(["ses_a", "ses_b"])
      expect(state.sessions.find((session) => session.sessionID === "ses_b")?.identity).toBe("b@host")
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

  test("folds the latest session cost snapshot", () => {
    const sessions = foldSessions([
      record({ ts: 1, kind: "session.created", sessionID: "root", refs: { cost: 0 } }),
      record({ ts: 2, kind: "session.updated", sessionID: "root", refs: { cost: 0.75 } }),
      record({ ts: 3, kind: "session.updated", sessionID: "root", refs: { cost: 1.5 } }),
    ])
    expect(sessions[0]?.cost).toBe(1.5)
  })
})

describe("lastCommandBySession", () => {
  test("keeps the latest command per session", () => {
    const commands = lastCommandBySession([
      record({ ts: 1, kind: "command", sessionID: "a", summary: "first", refs: { category: "test" } }),
      record({ ts: 2, kind: "command", sessionID: "b", summary: "other", refs: { category: "git-commit" } }),
      record({ ts: 3, kind: "command", sessionID: "a", summary: "second", refs: { category: "git-push" } }),
      record({ ts: 4, kind: "session.idle", sessionID: "a" }),
    ])

    expect(commands.get("a")).toEqual({ ts: 3, category: "git-push", summary: "second" })
    expect(commands.get("b")?.category).toBe("git-commit")
  })
})

describe("sanitizeProjectID", () => {
  test("maps degenerate ids to unknown", () => {
    expect(sanitizeProjectID("")).toBe("unknown")
    expect(sanitizeProjectID(".")).toBe("unknown")
    expect(sanitizeProjectID("..")).toBe("unknown")
    expect(sanitizeProjectID("...")).toBe("unknown")
    expect(sanitizeProjectID(". ")).toBe("unknown")
  })

  test("keeps separators inside the name", () => {
    expect(sanitizeProjectID("../evil")).toBe(".._evil")
    expect(sanitizeProjectID("a/b")).toBe("a_b")
    expect(sanitizeProjectID("a\\b")).toBe("a_b")
  })

  test("leaves realistic ids unchanged", () => {
    expect(sanitizeProjectID("subplug-test-project")).toBe("subplug-test-project")
    expect(sanitizeProjectID("0f3a9c1b2d4e5f60")).toBe("0f3a9c1b2d4e5f60")
    expect(sanitizeProjectID("name_1.2@host")).toBe("name_1.2@host")
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
  test("every session gets its full id appended to the cached base", () => {
    const first = agentIdentity("name@host", "ses_aaaabbbb")
    const second = agentIdentity("name@host", "ses_ccccdddd")
    expect(first).toBe("name@host/ses_aaaabbbb")
    expect(second).toBe("name@host/ses_ccccdddd")
    expect(first).not.toBe(second)
    expect(agentIdentity("name@host", "ses_aaaabbbb")).toBe(first)
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

  test("folds comms pointers into the monitor state", () => {
    const root = tempDir()
    try {
      const hubDir = hubRoot(root, "proj")
      const base = Date.parse("2026-09-27T11:00:00Z")
      const log = new EventLog(hubDir, "srv1")
      log.append(record({ ts: base, kind: "session.created", sessionID: "ses_to" }))
      log.append(
        record({
          ts: base + 1,
          kind: "comms.sent",
          sessionID: "ses_to",
          summary: "ping",
          refs: { msgID: "m1", to: "ses_to", from: "a@host" },
        }),
      )

      const state = readMonitorState(hubDir, root, { now: base + 1000 })
      expect(state.comms.length).toBe(1)
      expect(state.comms[0]?.state).toBe("sent")
      expect(inboxFor(state.comms, "ses_to", { now: base + 1000 }).length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("exposes recent commands for per-session tool age", () => {
    const root = tempDir()
    try {
      const hubDir = hubRoot(root, "proj")
      const base = Date.parse("2026-09-27T11:00:00Z")
      const log = new EventLog(hubDir, "srv1")
      log.append(record({ ts: base, kind: "session.created", sessionID: "ses_1" }))
      log.append(
        record({
          ts: base + 1,
          kind: "command",
          sessionID: "ses_1",
          summary: "bun test",
          refs: { category: "test" },
        }),
      )
      log.append(record({ ts: base + 2, kind: "session.idle", sessionID: "ses_1" }))

      const state = readMonitorState(hubDir, root, { now: Date.parse("2026-09-27T12:00:00Z") })
      expect(state.recentCommands.length).toBe(1)
      expect(lastCommandBySession(state.recentCommands).get("ses_1")?.summary).toBe("bun test")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
