import { describe, expect, test } from "bun:test"
import { buildTranscriptRows, elapsedMs, outputTail } from "../src/shared/transcript.ts"
import type { TranscriptMessage, TranscriptPart } from "../src/shared/transcript.ts"

function rowsFor(parts: TranscriptPart[], message: Partial<TranscriptMessage> = {}) {
  const msg: TranscriptMessage = { id: "m1", role: "assistant", ...message }
  return buildTranscriptRows([msg], () => parts)
}

describe("outputTail", () => {
  test("keeps the last lines and truncates from the start", () => {
    expect(outputTail("a\nb\nc\nd", { maxLines: 2 })).toBe("c\nd")
    expect(outputTail("x".repeat(50), { maxLines: 2, maxChars: 10 })).toBe(`…${"x".repeat(9)}`)
  })

  test("returns undefined for empty input", () => {
    expect(outputTail("   ")).toBeUndefined()
    expect(outputTail(undefined)).toBeUndefined()
  })
})

describe("elapsedMs", () => {
  test("uses the recorded end or falls back to now", () => {
    expect(elapsedMs({ state: { time: { start: 10, end: 40 } } })).toBe(30)
    expect(elapsedMs({ state: { time: { start: 10 } } }, 100)).toBe(90)
    expect(elapsedMs({})).toBeUndefined()
  })
})

describe("buildTranscriptRows", () => {
  test("renders text parts and skips empty ones", () => {
    const rows = rowsFor(
      [
        { id: "p1", type: "text", text: "hello world" },
        { id: "p2", type: "text", text: "   " },
      ],
      { role: "user", agent: "build" },
    )
    expect(rows).toEqual([{ kind: "text", key: "p1", role: "user", agent: "build", text: "hello world" }])
  })

  test("folds reasoning to a char count with preview", () => {
    const rows = rowsFor([{ id: "p1", type: "reasoning", text: "thinking hard about it" }])
    expect(rows[0]).toEqual({ kind: "reasoning", key: "p1", chars: 22, preview: "thinking hard about it" })
  })

  test("renders completed tools with title, elapsed, and output tail", () => {
    const rows = rowsFor(
      [
        {
          id: "t1",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            title: "run tests",
            output: "line1\nline2\nline3",
            time: { start: 1000, end: 3500 },
          },
        },
      ],
      { role: "assistant" },
    )
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

  test("renders running tools against now and errored tools with the message", () => {
    const running = rowsFor([
      { id: "t1", type: "tool", tool: "grep", state: { status: "running", time: { start: 1000 } } },
    ])
    expect(running[0]).toMatchObject({ kind: "tool", status: "running", elapsedMs: expect.any(Number) })

    const errored = rowsFor([
      { id: "t2", type: "tool", tool: "bash", state: { status: "error", error: "boom" } },
    ])
    expect(errored[0]).toMatchObject({ kind: "tool", status: "error", error: "boom" })
    expect((errored[0] as { elapsedMs?: number }).elapsedMs).toBeUndefined()
  })

  test("renders file, patch, agent, retry, compaction, and step rows", () => {
    const rows = rowsFor([
      { id: "f1", type: "file", filename: "src/a.ts", mime: "text/plain" },
      { id: "f2", type: "patch", files: ["a.ts", "b.ts"] },
      { id: "f3", type: "agent", name: "build" },
      { id: "f4", type: "retry", attempt: 2 },
      { id: "f5", type: "compaction", auto: true },
      { id: "f6", type: "step-finish", cost: 0.02, tokens: { input: 100, output: 20, reasoning: 5 } },
    ])
    expect(rows).toEqual([
      { kind: "file", key: "f1", filename: "src/a.ts", mime: "text/plain" },
      { kind: "patch", key: "f2", files: 2 },
      { kind: "agent", key: "f3", name: "build" },
      { kind: "retry", key: "f4", attempt: 2 },
      { kind: "compaction", key: "f5", auto: true },
      { kind: "step", key: "f6", cost: 0.02, tokens: 125 },
    ])
  })

  test("skips structural parts and falls through unknown types", () => {
    const rows = rowsFor([
      { id: "s1", type: "step-start" },
      { id: "s2", type: "snapshot" },
      { id: "s3", type: "subtask" },
      { id: "s4", type: "mystery" },
    ])
    expect(rows).toEqual([{ kind: "other", key: "s4", label: "mystery" }])
  })

  test("keys parts without an id by message and index", () => {
    const rows = rowsFor([{ type: "text", text: "first" }, { type: "text", text: "second" }])
    expect(rows.map((row) => row.key)).toEqual(["m1#0", "m1#1"])
  })
})
