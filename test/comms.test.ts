import { describe, expect, test } from "bun:test"
import {
  buildInboxBlock,
  foldComms,
  inboxFor,
  messageSummary,
  resolveTargets,
} from "../src/hub/comms.ts"
import { foldSessions } from "../src/hub/fold.ts"
import type { CommsPointer, EventRecord, SessionNode } from "../src/shared/types.ts"

function record(overrides: Partial<EventRecord> & { kind: EventRecord["kind"] }): EventRecord {
  return { ts: 1000, serverID: "srv1", ...overrides }
}

function pointer(overrides: Partial<CommsPointer> & { msgID: string }): CommsPointer {
  return {
    from: "a@host",
    to: "ses_to",
    kind: "message",
    delivery: "queue",
    state: "sent",
    ts: 100,
    summary: "ping",
    serverID: "srv1",
    ...overrides,
  }
}

function session(sessionID: string): SessionNode {
  return { sessionID, kind: "root", status: "idle", lastEventAt: 1 }
}

describe("messageSummary", () => {
  test("collapses whitespace and truncates", () => {
    expect(messageSummary("  hello\n\nworld  ")).toBe("hello world")
    expect(messageSummary("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`)
  })
})

describe("foldComms", () => {
  test("folds sent to delivered to seen and keeps metadata", () => {
    const pointers = foldComms([
      record({
        ts: 1,
        kind: "comms.sent",
        sessionID: "ses_to",
        summary: "ping",
        refs: { msgID: "m1", to: "ses_to", from: "a@host", kind: "message", delivery: "queue" },
      }),
      record({ ts: 2, kind: "comms.delivered", sessionID: "ses_to", refs: { msgID: "m1" } }),
      record({ ts: 3, kind: "comms.seen", sessionID: "ses_to", refs: { msgID: "m1" } }),
    ])

    expect(pointers.length).toBe(1)
    expect(pointers[0]).toMatchObject({
      msgID: "m1",
      from: "a@host",
      to: "ses_to",
      kind: "message",
      delivery: "queue",
      state: "seen",
      summary: "ping",
      ts: 1,
      at: 3,
    })
  })

  test("ignores orphan updates and duplicate sends", () => {
    const pointers = foldComms([
      record({ ts: 1, kind: "comms.delivered", refs: { msgID: "ghost" } }),
      record({ ts: 2, kind: "comms.sent", refs: { msgID: "m1", to: "ses_to" } }),
      record({ ts: 3, kind: "comms.sent", refs: { msgID: "m1", to: "ses_other" } }),
    ])

    expect(pointers.length).toBe(1)
    expect(pointers[0]?.to).toBe("ses_to")
  })

  test("comms records never resurrect sessions in the fold", () => {
    const sessions = foldSessions([
      record({
        ts: 1,
        kind: "comms.sent",
        sessionID: "ses_ghost",
        refs: { msgID: "m1", to: "ses_ghost", from: "a@host" },
      }),
      record({ ts: 2, kind: "comms.seen", sessionID: "ses_ghost", refs: { msgID: "m1" } }),
    ])
    expect(sessions).toEqual([])
  })
})

describe("inboxFor", () => {
  const pointers = [
    pointer({ msgID: "m1", to: "ses_a", ts: 100 }),
    pointer({ msgID: "m2", to: "ses_a", ts: 200, state: "seen" }),
    pointer({ msgID: "m3", to: "ses_b", ts: 300 }),
    pointer({ msgID: "m4", to: "ses_a", ts: 400 }),
  ]

  test("filters by recipient and excludes seen pointers", () => {
    expect(inboxFor(pointers, "ses_a", { now: 500, ttlMs: 1000 }).map((item) => item.msgID)).toEqual(["m1", "m4"])
  })

  test("applies the limit and ttl", () => {
    expect(inboxFor(pointers, "ses_a", { now: 500, ttlMs: 1000, limit: 1 }).map((item) => item.msgID)).toEqual(["m4"])
    expect(inboxFor(pointers, "ses_a", { now: 1500, ttlMs: 1000 })).toEqual([])
  })
})

describe("resolveTargets", () => {
  const sessions = [session("ses_aaa111"), session("ses_aaa222"), session("ses_bbb333")]

  test("matches exact ids and unique prefixes", () => {
    expect(resolveTargets(sessions, "ses_aaa111")).toMatchObject({ kind: "match" })
    expect(resolveTargets(sessions, "ses_bbb")).toMatchObject({ kind: "match", session: { sessionID: "ses_bbb333" } })
  })

  test("reports ambiguity and misses", () => {
    const ambiguous = resolveTargets(sessions, "ses_aaa")
    expect(ambiguous.kind).toBe("ambiguous")
    if (ambiguous.kind === "ambiguous") expect(ambiguous.candidates.length).toBe(2)
    expect(resolveTargets(sessions, "zzz").kind).toBe("none")
    expect(resolveTargets(sessions, "   ").kind).toBe("none")
  })
})

describe("buildInboxBlock", () => {
  test("returns undefined for an empty inbox", () => {
    expect(buildInboxBlock([])).toBeUndefined()
  })

  test("frames entries as untrusted data and returns their ids", () => {
    const block = buildInboxBlock([
      { msgID: "m1", from: "a@host", summary: "please review", ts: 1_700_000_000_000, kind: "message" },
      { msgID: "m2", from: "b@host", summary: "status?", ts: 1_700_000_001_000 },
    ])
    expect(block).toBeDefined()
    expect(block!.text).toContain("untrusted data")
    expect(block!.text).toContain("from=a@host")
    expect(block!.text).toContain("please review")
    expect(block!.msgIDs).toEqual(["m1", "m2"])
  })

  test("caps bytes and drops entries that do not fit", () => {
    const entries = [
      { msgID: "m1", from: "a@host", summary: "first", ts: 1 },
      { msgID: "m2", from: "b@host", summary: "x".repeat(400), ts: 2 },
    ]
    const block = buildInboxBlock(entries, { maxBytes: 220 })
    expect(block?.msgIDs).toEqual(["m1"])
    expect(buildInboxBlock(entries, { maxBytes: 10 })).toBeUndefined()
  })
})
