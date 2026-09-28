import { describe, expect, test } from "bun:test"
import { FollowUpConfirmationRequired, sendFollowUp, type FollowUpRequest, type FollowUpTransport } from "../src/shared/follow-up.ts"
import type { EventRecord, SessionNode } from "../src/shared/types.ts"

const target: SessionNode = {
  sessionID: "ses_child", parentID: "ses_parent", kind: "subagent", status: "idle", directory: "/tmp/project", lastEventAt: 0,
}

function setup(status = "idle") {
  const calls: Array<{ method: string; request: FollowUpRequest }> = []
  const records: EventRecord[] = []
  const transport: FollowUpTransport = {
    get: async () => ({ data: { id: target.sessionID } }),
    status: async () => ({ data: { [target.sessionID]: { type: status } } }),
    prompt: async (request) => { calls.push({ method: "prompt", request }); return { data: {} } },
    promptAsync: async (request) => { calls.push({ method: "promptAsync", request }); return { data: undefined } },
  }
  const send = (message = "Follow-up context", confirm = false) => sendFollowUp({
    target, message, from: "user", serverID: "test", confirm, transport, record: (event) => { records.push(event) },
  })
  return { calls, records, transport, send }
}

describe("follow-up delivery", () => {
  test("resumes an idle subagent without waiting for its response", async () => {
    const { calls, records, transport, send } = setup()
    transport.prompt = async () => new Promise(() => {})
    const sent = await send()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "promptAsync", request: { sessionID: target.sessionID, directory: target.directory, noReply: false } })
    expect(records[0]?.refs?.msgID).toBe(sent.msgID)
    expect(records[0]?.refs?.kind).toBe("follow-up")
  })

  test("checks live status even when the hub says idle, and requires confirmation", async () => {
    const { calls, records, send } = setup("busy")
    await expect(send()).rejects.toBeInstanceOf(FollowUpConfirmationRequired)
    expect(calls).toHaveLength(0)
    expect(records).toHaveLength(0)
    const sent = await send("Use the new fixture", true)
    expect(sent.noReply).toBe(true)
    expect(calls[0]).toMatchObject({ method: "prompt", request: { noReply: true, parts: [{ type: "text", text: "Use the new fixture" }] } })
    expect(records[0]?.refs?.delivery).toBe("queue")
  })

  test("retrying agents use confirmed queue delivery", async () => {
    const { send } = setup("retry")
    await expect(send()).rejects.toBeInstanceOf(FollowUpConfirmationRequired)
    expect((await send("context", true)).noReply).toBe(true)
  })

  test("preserves the subagent's native agent, model and variant", async () => {
    const { calls, transport, send } = setup()
    transport.get = async () => ({ data: { id: target.sessionID, agent: "explore", model: { providerID: "test", id: "subagent-model", variant: "high" } } })
    await send()
    expect(calls[0]?.request).toMatchObject({ agent: "explore", model: { providerID: "test", modelID: "subagent-model" }, variant: "high" })
  })

  test("never records a failed SDK write as sent", async () => {
    const { records, transport, send } = setup()
    transport.promptAsync = async () => ({ error: { name: "NotFoundError" } })
    await expect(send()).rejects.toThrow("rejected")
    expect(records).toHaveLength(0)
  })

  test("keeps full context in the native request and only a redacted summary in the hub", async () => {
    const { calls, records, send } = setup()
    const text = `token=very-secret\n${"context ".repeat(100)}`
    await send(text)
    expect(calls[0]?.request.parts[0]?.text).toBe(text.trim())
    expect(JSON.stringify(records)).not.toContain("very-secret")
    expect(records[0]?.summary?.length).toBeLessThanOrEqual(160)
  })

  test("uses native time-ordered message IDs for consecutive follow-ups", async () => {
    const { send } = setup()
    const first = await send()
    const second = await send()
    expect(first.msgID).toMatch(/^msg_[0-9a-f]{26}$/)
    expect(second.msgID > first.msgID).toBe(true)
  })

  test("rejects empty context and deleted targets before writing", async () => {
    const { calls, send, transport, records } = setup()
    await expect(send("  ")).rejects.toThrow("empty")
    await expect(sendFollowUp({ target: { ...target, deleted: true }, message: "context", from: "user", serverID: "test", transport, record: () => {} })).rejects.toThrow("deleted")
    expect(calls).toHaveLength(0)
    expect(records).toHaveLength(0)
  })
})
