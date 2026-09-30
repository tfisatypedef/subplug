import { randomUUID } from "node:crypto"
import { messageSummary } from "../hub/comms.ts"
import { redactText } from "./redact.ts"
import type { EventRecord, SessionNode, SessionStatus } from "./types.ts"

export type FollowUpPrompt = {
  sessionID: string
  text: string
  delivery: "steer" | "queue"
}

export type FollowUpTransport = {
  get: (sessionID: string) => Promise<unknown>
  prompt: (request: FollowUpPrompt) => Promise<unknown>
}

export class FollowUpConfirmationRequired extends Error {
  constructor(readonly status: SessionStatus) {
    super(`target is ${status}; confirm to queue follow-up context for its next step`)
  }
}

function responseData(response: unknown): unknown {
  if (!response || typeof response !== "object") throw new Error("empty response from opencode")
  if ("error" in response && response.error !== undefined) {
    throw new Error(`opencode rejected the request: ${JSON.stringify(response.error)}`)
  }
  return "data" in response ? response.data : response
}

let lastMessageTick = 0n

function messageID(): string {
  // Native messages are ordered by ID. Match OpenCode's 48-bit timestamp +
  // sequence prefix instead of a random prefix that can sort behind old turns.
  const tick = BigInt(Date.now()) * 4096n + 1n
  lastMessageTick = tick > lastMessageTick ? tick : lastMessageTick + 1n
  const prefix = BigInt.asUintN(48, lastMessageTick).toString(16).padStart(12, "0")
  return `msg_${prefix}${randomUUID().replaceAll("-", "").slice(0, 14)}`
}

export function followUpError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, 160)
}

/**
 * v1's transport had separate sync/async prompt calls; v2's `session.prompt`
 * admits durably and schedules asynchronously, so delivery (not the call shape)
 * decides whether the target resumes now or consumes the message at its next
 * step boundary.
 */
export async function sendFollowUp(input: {
  target: SessionNode
  status: SessionStatus
  message: string
  from: string
  serverID: string
  confirm?: boolean
  transport: FollowUpTransport
  record: (event: EventRecord) => void | Promise<void>
}): Promise<{ msgID: string; noReply: boolean; status: SessionStatus }> {
  const text = input.message.trim()
  if (!text) throw new Error("follow-up context cannot be empty")
  if (input.target.deleted) throw new Error("target session is deleted")

  const noReply = input.status !== "idle"
  if (noReply && !input.confirm) throw new FollowUpConfirmationRequired(input.status)

  const native = responseData(await input.transport.get(input.target.sessionID))
  if (!native || typeof native !== "object" || Array.isArray(native)) {
    throw new Error("could not read target session")
  }

  const admitted = responseData(
    await input.transport.prompt({ sessionID: input.target.sessionID, text, delivery: noReply ? "queue" : "steer" }),
  )
  const nativeID = admitted && typeof admitted === "object" && "id" in admitted && typeof admitted.id === "string"
    ? admitted.id
    : undefined
  const msgID = nativeID || messageID()
  await input.record({
    ts: Date.now(),
    serverID: input.serverID,
    sessionID: input.target.sessionID,
    kind: "comms.sent",
    summary: messageSummary(redactText(text)),
    refs: { msgID, to: input.target.sessionID, from: input.from, kind: "follow-up", delivery: noReply ? "queue" : "prompt" },
  })
  return { msgID, noReply, status: input.status }
}
