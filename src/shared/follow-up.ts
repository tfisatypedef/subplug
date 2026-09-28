import { randomUUID } from "node:crypto"
import { messageSummary } from "../hub/comms.ts"
import { redactText } from "./redact.ts"
import type { EventRecord, SessionNode, SessionStatus } from "./types.ts"

export type FollowUpRequest = {
  sessionID: string
  directory?: string
  messageID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  noReply: boolean
  parts: Array<{ type: "text"; text: string }>
}

export type FollowUpTransport = {
  get: (sessionID: string, directory?: string) => Promise<unknown>
  status: (directory?: string) => Promise<unknown>
  prompt: (request: FollowUpRequest) => Promise<unknown>
  promptAsync: (request: FollowUpRequest) => Promise<unknown>
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

/** Both entrypoints use the native /session APIs; only their argument shapes differ. */
export async function sendFollowUp(input: {
  target: SessionNode
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

  // The hub can lag a turn behind. Check the runtime again at send time.
  const [sessionResponse, statusResponse] = await Promise.all([
    input.transport.get(input.target.sessionID, input.target.directory),
    input.transport.status(input.target.directory),
  ])
  const native = responseData(sessionResponse)
  if (!native || typeof native !== "object" || Array.isArray(native)) throw new Error("could not read target session")
  const agent = "agent" in native && typeof native.agent === "string" ? native.agent : input.target.agent
  const nativeModel = "model" in native && native.model && typeof native.model === "object" ? native.model : undefined
  const modelID = nativeModel && ("modelID" in nativeModel ? nativeModel.modelID : "id" in nativeModel ? nativeModel.id : undefined)
  const model = nativeModel && "providerID" in nativeModel && typeof nativeModel.providerID === "string" && typeof modelID === "string"
    ? { providerID: nativeModel.providerID, modelID }
    : undefined
  const variant = nativeModel && "variant" in nativeModel && typeof nativeModel.variant === "string" && nativeModel.variant !== "default"
    ? nativeModel.variant
    : undefined
  const statuses = responseData(statusResponse)
  if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
    throw new Error("could not read session status")
  }
  const live = (statuses as Record<string, { type?: string }>)[input.target.sessionID]?.type ?? "idle"
  const status: SessionStatus = live === "idle" || live === "busy" || live === "retry" ? live : "unknown"
  const noReply = status !== "idle"
  if (noReply && !input.confirm) throw new FollowUpConfirmationRequired(status)

  const msgID = messageID()
  const request: FollowUpRequest = {
    sessionID: input.target.sessionID,
    directory: input.target.directory,
    messageID: msgID,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    noReply,
    parts: [{ type: "text", text }],
  }
  // Queue writes return after persistence. Idle turns use the async endpoint so
  // an agent calling swarm_send never waits for the recipient's whole response.
  responseData(await (noReply ? input.transport.prompt(request) : input.transport.promptAsync(request)))
  await input.record({
    ts: Date.now(),
    serverID: input.serverID,
    sessionID: input.target.sessionID,
    kind: "comms.sent",
    summary: messageSummary(redactText(text)),
    refs: { msgID, to: input.target.sessionID, from: input.from, kind: "follow-up", delivery: noReply ? "queue" : "prompt" },
  })
  return { msgID, noReply, status }
}
