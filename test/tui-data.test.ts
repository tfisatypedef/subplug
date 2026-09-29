import { describe, expect, test } from "bun:test"
import {
  backfillSessions,
  listNativeSessions,
  loadSessionDetailV2,
  loadTranscriptV2,
  sessionNeedsInput,
  type TuiDataContext,
  type V2SessionInfo,
} from "../src/tui/data.ts"
import type { V2Message } from "../src/shared/transcript.ts"
import type { EventRecord } from "../src/shared/types.ts"

function makeContext(options: {
  stored?: V2Message[]
  native?: V2Message[]
  sessions?: V2SessionInfo[]
  sessionStore?: V2SessionInfo[]
  permission?: unknown[]
  form?: unknown[]
  failSync?: boolean
} = {}) {
  const syncCalls: string[] = []
  const stored = options.stored ?? []
  const ctx: TuiDataContext = {
    data: {
      session: {
        list: () => options.sessionStore,
        get: (sessionID) => options.sessionStore?.find((session) => session.id === sessionID),
        message: {
          list: () => stored,
          sync: async (sessionID) => {
            syncCalls.push(sessionID)
            if (options.failSync) throw new Error("offline")
          },
        },
        permission: { list: () => options.permission },
        form: { list: () => options.form },
      },
      location: {
        model: {
          list: () => [
            { id: "test/model", limit: { context: 200_000 } },
            { id: "other/model", limit: { context: 8_000 } },
          ],
        },
      },
    },
    client: {
      session: {
        context: async () => (options.native ? { data: options.native } : { data: [] }),
        list: async () => ({ data: { data: options.sessions ?? [], cursor: {} } }),
      },
    },
  }
  return { ctx, syncCalls }
}

describe("v2 transcript loading", () => {
  test("prefers the synced store", async () => {
    const { ctx, syncCalls } = makeContext({
      stored: [{ id: "m1", type: "user", text: "from store" }],
      native: [{ id: "m2", type: "user", text: "from client" }],
    })
    const source = await loadTranscriptV2(ctx, "ses_a")
    expect(syncCalls).toEqual(["ses_a"])
    expect(source.source).toBe("store")
    expect(source.messages[0]?.text).toBe("from store")
  })

  test("falls back to the native context and tolerates a failing sync", async () => {
    const { ctx } = makeContext({ native: [{ id: "m2", type: "user", text: "from client" }], failSync: true })
    const source = await loadTranscriptV2(ctx, "ses_a")
    expect(source.source).toBe("client")
    expect(source.messages[0]?.text).toBe("from client")

    const empty = makeContext()
    expect((await loadTranscriptV2(empty.ctx, "ses_b")).source).toBe("none")
  })
})

describe("v2 session detail", () => {
  test("computes rows, tokens, cost, and the model context limit", async () => {
    const stored: V2Message[] = [
      { id: "u1", type: "user", text: "hello" },
      {
        id: "m1",
        type: "assistant",
        agent: "build",
        model: { id: "test/model", providerID: "test" },
        content: [{ type: "text", text: "hi" }],
        cost: 1.5,
        tokens: { input: 12_000, output: 300, reasoning: 50, cache: { read: 500, write: 0 } },
      },
      {
        id: "m2",
        type: "assistant",
        model: { id: "other/model" },
        content: [{ type: "text", text: "later" }],
        cost: 0.5,
        tokens: { input: 20_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]
    const { ctx } = makeContext({ stored })
    const detail = await loadSessionDetailV2(ctx, "ses_a", { now: 10 })
    expect(detail.source).toBe("store")
    expect(detail.rows.length).toBe(5)
    expect(detail.tokens).toBe(20_000)
    expect(detail.cost).toBe(2)
    expect(detail.contextLimit).toBe(8_000)
    expect(detail.todos).toEqual([])
  })
})

describe("v2 session helpers", () => {
  test("detects sessions waiting on permission or form input", () => {
    const quiet = makeContext()
    expect(sessionNeedsInput(quiet.ctx, "ses_a")).toBe(false)

    const permission = makeContext({ permission: [{}] })
    expect(sessionNeedsInput(permission.ctx, "ses_a")).toBe(true)

    const form = makeContext({ form: [{}] })
    expect(sessionNeedsInput(form.ctx, "ses_a")).toBe(true)
  })

  test("unwraps native session listings", async () => {
    const sessions: V2SessionInfo[] = [{ id: "ses_a" }, { id: "ses_b" }]
    const { ctx } = makeContext({ sessions })
    expect((await listNativeSessions(ctx)).map((session) => session.id)).toEqual(["ses_a", "ses_b"])

    const directish = makeContext()
    directish.ctx.client.session.list = async () => ({ data: sessions })
    expect((await listNativeSessions(directish.ctx)).length).toBe(2)
  })

  test("backfills only sessions the hub has not seen", () => {
    const records: EventRecord[] = []
    const written = backfillSessions(
      new Set(["ses_known"]),
      [
        { id: "ses_known", title: "known" },
        {
          id: "ses_new",
          parentID: "ses_known",
          title: "new child",
          agent: "explore",
          model: { id: "test/model" },
          cost: 0.25,
          location: { directory: "/repo" },
        },
      ],
      (record) => records.push(record),
      "subplug-tui",
      123,
    )
    expect(written).toBe(1)
    expect(records).toEqual([
      {
        ts: 123,
        serverID: "subplug-tui",
        sessionID: "ses_new",
        parentID: "ses_known",
        kind: "session.created",
        refs: {
          title: "new child",
          directory: "/repo",
          parentID: "ses_known",
          agent: "explore",
          model: "test/model",
          cost: 0.25,
        },
      },
    ])
  })
})
