import { describe, expect, test } from "bun:test"
import {
  FollowUpConfirmationRequired,
  sendFollowUp,
  type FollowUpPrompt,
  type FollowUpTransport,
} from "../src/shared/follow-up.ts"
import type { EventRecord, SessionNode, SessionStatus } from "../src/shared/types.ts"

const target: SessionNode = {
  sessionID: "ses_child",
  parentID: "ses_parent",
  kind: "subagent",
  status: "idle",
  directory: "/tmp/project",
  lastEventAt: 0,
}

function setup(status: SessionStatus = "idle") {
  const calls: FollowUpPrompt[] = []
  const records: EventRecord[] = []
  const transport: FollowUpTransport = {
    get: async () => ({ id: target.sessionID }),
    prompt: async (request) => {
      calls.push(request)
      return { id: "msg_host0000000000000000000001" }
    },
  }
  const send = (message = "Follow-up context", confirm = false) =>
    sendFollowUp({
      target,
      status,
      message,
      from: "user",
      serverID: "test",
      confirm,
      transport,
      record: (event) => {
        records.push(event)
      },
    })
  return { calls, records, transport, send }
}

describe("follow-up delivery", () => {
  test("steers an idle target without waiting for its response", async () => {
    const { calls, records, send } = setup()
    const sent = await send()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionID: target.sessionID, text: "Follow-up context", delivery: "steer" })
    expect(sent.noReply).toBe(false)
    expect(records[0]?.refs?.msgID).toBe(sent.msgID)
    expect(records[0]?.refs?.kind).toBe("follow-up")
    expect(records[0]?.refs?.delivery).toBe("prompt")
  })

  test("requires confirmation for busy targets and queues with confirm", async () => {
    const { calls, records, send } = setup("busy")
    await expect(send()).rejects.toBeInstanceOf(FollowUpConfirmationRequired)
    expect(calls).toHaveLength(0)
    expect(records).toHaveLength(0)

    const sent = await send("Use the new fixture", true)
    expect(sent.noReply).toBe(true)
    expect(calls[0]).toMatchObject({ text: "Use the new fixture", delivery: "queue" })
    expect(records[0]?.refs?.delivery).toBe("queue")
  })

  test("retrying agents use confirmed queue delivery", async () => {
    const { send } = setup("retry")
    await expect(send()).rejects.toBeInstanceOf(FollowUpConfirmationRequired)
    expect((await send("context", true)).noReply).toBe(true)
  })

  test("never records a failed write as sent", async () => {
    const { records, transport, send } = setup()
    transport.prompt = async () => ({ error: { name: "NotFoundError" } })
    await expect(send()).rejects.toThrow("rejected")
    expect(records).toHaveLength(0)
  })

  test("only a redacted summary reaches the hub", async () => {
    const { calls, records, send } = setup()
    const text = `token=very-secret\n${"context ".repeat(100)}`
    await send(text)
    expect(calls[0]?.text).toBe(text.trim())
    expect(JSON.stringify(records)).not.toContain("very-secret")
    expect(records[0]?.summary?.length).toBeLessThanOrEqual(160)
  })

  test("falls back to a native time-ordered message id", async () => {
    const { transport, send } = setup()
    transport.prompt = async () => ({})
    const sent = await send()
    expect(sent.msgID).toMatch(/^msg_[0-9a-f]{26}$/)
  })

  test("rejects empty context and deleted targets before writing", async () => {
    const { calls, send, transport, records } = setup()
    await expect(send("  ")).rejects.toThrow("empty")
    await expect(
      sendFollowUp({
        target: { ...target, deleted: true },
        status: "idle",
        message: "context",
        from: "user",
        serverID: "test",
        transport,
        record: () => {},
      }),
    ).rejects.toThrow("deleted")
    expect(calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })
})
