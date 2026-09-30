import { describe, expect, test } from "bun:test"
import { buildTranscriptRowsV2, type V2Message } from "../src/shared/transcript.ts"

function rowsFor(message: V2Message) {
  return buildTranscriptRowsV2([message])
}

describe("buildTranscriptRowsV2", () => {
  test("renders user, synthetic, system, and skill turns", () => {
    expect(rowsFor({ id: "u1", type: "user", text: "hello", time: { created: 1 } })).toEqual([
      { kind: "text", key: "u1", role: "user", agent: undefined, text: "hello" },
    ])
    expect(rowsFor({ id: "s1", type: "synthetic", text: "notice" })[0]).toMatchObject({ role: "synthetic" })
    expect(rowsFor({ id: "s2", type: "system", text: "system note" })[0]).toMatchObject({ role: "system" })
    expect(rowsFor({ id: "k1", type: "skill", name: "review" })[0]).toMatchObject({ kind: "text", role: "skill" })
  })

  test("folds assistant text and reasoning entries", () => {
    const rows = rowsFor({
      id: "m1",
      type: "assistant",
      agent: "build",
      content: [
        { type: "text", text: "working on it" },
        { type: "reasoning", text: "thinking hard about it" },
        { type: "text", text: "   " },
      ],
    })
    expect(rows).toEqual([
      { kind: "text", key: "m1#0", role: "assistant", agent: "build", text: "working on it" },
      { kind: "reasoning", key: "m1#1", chars: 22, preview: "thinking hard about it" },
    ])
  })

  test("renders completed tools with output tail and elapsed time", () => {
    const rows = rowsFor({
      id: "m1",
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "t1",
          name: "bash",
          state: {
            status: "completed",
            input: {},
            metadata: { title: "run tests" },
            content: [{ type: "text", text: "line1\nline2\nline3" }],
          },
          time: { created: 1000, ran: 1000, completed: 3500 },
        },
      ],
    })
    expect(rows[0]).toMatchObject({
      kind: "tool",
      key: "t1",
      tool: "bash",
      status: "completed",
      title: "run tests",
      elapsedMs: 2500,
      outputTail: "line2\nline3",
    })
  })

  test("renders running, streaming, and errored tools", () => {
    const rows = rowsFor({
      id: "m1",
      type: "assistant",
      content: [
        { type: "tool", id: "t1", name: "grep", state: { status: "running", input: {}, metadata: {} }, time: { created: 1000 } },
        { type: "tool", id: "t2", name: "read", state: { status: "streaming", input: "{" }, time: { created: 500 } },
        {
          type: "tool",
          id: "t3",
          name: "bash",
          state: { status: "error", input: {}, error: { type: "tool", message: "boom" } },
          time: { created: 100 },
        },
      ],
    })
    const running = rows[0] as { kind: string; status: string; elapsedMs?: number }
    expect(typeof running.elapsedMs).toBe("number")
    expect(running.elapsedMs ?? -1).toBeGreaterThanOrEqual(0)
    expect(running).toMatchObject({ kind: "tool", status: "running" })
    expect(rows[1]).toMatchObject({ kind: "tool", key: "t2", status: "streaming" })
    expect(rows[2]).toMatchObject({ kind: "tool", key: "t3", status: "error", error: "boom" })
  })

  test("renders retries and step usage", () => {
    const rows = rowsFor({
      id: "m1",
      type: "assistant",
      content: [{ type: "text", text: "done" }],
      retry: { attempt: 2 },
      cost: 0.02,
      tokens: { input: 100, output: 20, reasoning: 5 },
    })
    expect(rows.at(-2)).toEqual({ kind: "retry", key: "m1#retry", attempt: 2 })
    expect(rows.at(-1)).toEqual({ kind: "step", key: "m1#step", cost: 0.02, tokens: 125 })
  })

  test("renders compaction states and structural notices", () => {
    expect(rowsFor({ id: "c1", type: "compaction", status: "running", reason: "auto" })).toEqual([
      { kind: "compaction", key: "c1", auto: true },
    ])
    expect(rowsFor({ id: "c2", type: "compaction", status: "failed", reason: "manual" })).toEqual([
      { kind: "other", key: "c2", label: "compaction failed" },
    ])
    expect(rowsFor({ id: "c3", type: "compaction", status: "completed", reason: "auto", cost: 0.01 })).toEqual([
      { kind: "compaction", key: "c3", auto: true },
      { kind: "step", key: "c3#step", cost: 0.01, tokens: undefined },
    ])
    expect(rowsFor({ id: "a1", type: "agent-switched", agent: "plan" })).toEqual([
      { kind: "agent", key: "a1", name: "plan" },
    ])
    expect(rowsFor({ id: "mo1", type: "model-switched", model: { id: "test/model" } })).toEqual([
      { kind: "other", key: "mo1", label: "model test/model" },
    ])
    expect(rowsFor({ id: "sh1", type: "shell", status: "exited" })).toEqual([
      { kind: "other", key: "sh1", label: "shell exited" },
    ])
    expect(rowsFor({ id: "i1", type: "idle", status: "succeeded" })).toEqual([])
  })
})
