import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  buildTranscriptRows,
  type TranscriptMessage,
  type TranscriptPart,
  type TranscriptTokens,
  type TranscriptRow,
} from "../shared/transcript.ts"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export type SessionDetailState = {
  todos: Array<{ content: string; status: string }>
  rows: TranscriptRow[]
  tokens: number
  cost: number
  contextLimit?: number
  source: TranscriptSource["source"]
}

function unwrapData<T>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") return undefined
  const data = (response as { data?: T }).data
  return data === undefined ? (response as T) : data
}

function maybeNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toTokens(value: unknown): TranscriptTokens | undefined {
  const tokens = record(value) ? value : undefined
  if (!tokens) return undefined
  const cache = record(tokens.cache) ? tokens.cache : undefined
  return {
    input: maybeNum(tokens.input),
    output: maybeNum(tokens.output),
    reasoning: maybeNum(tokens.reasoning),
    cache: cache ? { read: maybeNum(cache.read), write: maybeNum(cache.write) } : undefined,
  }
}

function toTranscriptMessage(value: unknown): TranscriptMessage {
  const info = record(value) ? value : {}
  const model = record(info.model) ? info.model : undefined
  const time = record(info.time) ? info.time : undefined
  const modelID =
    typeof info.modelID === "string"
      ? info.modelID
      : typeof model?.modelID === "string"
        ? model.modelID
        : typeof model?.id === "string"
          ? model.id
          : undefined
  return {
    id: typeof info.id === "string" ? info.id : "",
    role: typeof info.role === "string" ? info.role : "?",
    agent: typeof info.agent === "string" ? info.agent : undefined,
    model: modelID,
    providerID: typeof info.providerID === "string" ? info.providerID : undefined,
    cost: maybeNum(info.cost),
    tokens: toTokens(info.tokens),
    time: time ? { created: maybeNum(time.created), completed: maybeNum(time.completed) } : undefined,
  }
}

function toTranscriptPart(value: unknown): TranscriptPart {
  const part = record(value) ? value : {}
  const state = record(part.state) ? part.state : undefined
  const time = state && record(state.time) ? state.time : undefined
  const files = Array.isArray(part.files)
    ? part.files.filter((item): item is string => typeof item === "string")
    : undefined
  return {
    id: typeof part.id === "string" ? part.id : undefined,
    type: typeof part.type === "string" ? part.type : "unknown",
    text: typeof part.text === "string" ? part.text : undefined,
    tool: typeof part.tool === "string" ? part.tool : undefined,
    callID: typeof part.callID === "string" ? part.callID : undefined,
    state: state
      ? {
          status: typeof state.status === "string" ? state.status : undefined,
          title: typeof state.title === "string" ? state.title : undefined,
          output: typeof state.output === "string" ? state.output : undefined,
          error: typeof state.error === "string" ? state.error : undefined,
          time: time ? { start: maybeNum(time.start), end: maybeNum(time.end) } : undefined,
        }
      : undefined,
    filename: typeof part.filename === "string" ? part.filename : undefined,
    mime: typeof part.mime === "string" ? part.mime : undefined,
    url: typeof part.url === "string" ? part.url : undefined,
    files,
    hash: typeof part.hash === "string" ? part.hash : undefined,
    name: typeof part.name === "string" ? part.name : undefined,
    auto: typeof part.auto === "boolean" ? part.auto : undefined,
    attempt: maybeNum(part.attempt),
    cost: maybeNum(part.cost),
    tokens: toTokens(part.tokens),
  }
}

type TranscriptSource = {
  source: "store" | "client" | "none"
  messages: TranscriptMessage[]
  partsFor: (messageID: string) => readonly TranscriptPart[]
}

const TRANSCRIPT_LIMIT = 60

export async function loadTranscript(api: TuiPluginApi, sessionID: string): Promise<TranscriptSource> {
  const store = api.state.session
  if (store.get(sessionID)) {
    const messages = store.messages(sessionID)
    if (messages.length) {
      const transcript = messages.map((message) => toTranscriptMessage(message))
      const parts = new Map<string, TranscriptPart[]>()
      let partCount = 0
      for (const message of transcript) {
        const list = api.state.part(message.id).map((part) => toTranscriptPart(part))
        partCount += list.length
        parts.set(message.id, list)
      }
      if (partCount > 0) {
        return { source: "store", messages: transcript, partsFor: (id) => parts.get(id) ?? [] }
      }
    }
  }

  const client = api.client as unknown as {
    session: { messages: (input: { sessionID: string; limit?: number }) => Promise<unknown> }
  }
  try {
    const rows = unwrapData<Array<{ info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }>>(
      await client.session.messages({ sessionID, limit: TRANSCRIPT_LIMIT }),
    )
    if (Array.isArray(rows) && rows.length) {
      const messages = rows.map((row) => toTranscriptMessage(row.info))
      const parts = new Map<string, TranscriptPart[]>()
      rows.forEach((row, index) => {
        const messageID = messages[index]?.id ?? ""
        parts.set(
          messageID,
          (row.parts ?? []).map((part) => toTranscriptPart(part)),
        )
      })
      return { source: "client", messages, partsFor: (id) => parts.get(id) ?? [] }
    }
  } catch {
    // fall through to an empty transcript
  }
  return { source: "none", messages: [], partsFor: () => [] }
}

function contextUsage(messages: readonly TranscriptMessage[]): {
  tokens: number
  cost: number
  providerID?: string
  modelID?: string
} {
  let tokens = 0
  let cost = 0
  let providerID: string | undefined
  let modelID: string | undefined
  for (const message of messages) {
    if (message.role !== "assistant") continue
    cost += message.cost ?? 0
    const input = message.tokens?.input ?? 0
    if (input > tokens) {
      tokens = input
      providerID = message.providerID
      modelID = message.model
    }
  }
  return { tokens, cost, providerID, modelID }
}

export async function loadSessionDetail(api: TuiPluginApi, sessionID: string): Promise<SessionDetailState> {
  const state: SessionDetailState = { todos: [], rows: [], tokens: 0, cost: 0, source: "none" }
  const client = api.client as unknown as {
    session: { todo: (input: { sessionID: string }) => Promise<unknown> }
  }
  const [todoResult, transcript] = await Promise.all([
    client.session.todo({ sessionID }).catch(() => undefined),
    loadTranscript(api, sessionID),
  ])

  const todoRows = unwrapData<Array<{ content?: string; status?: string }>>(todoResult)
  if (Array.isArray(todoRows)) {
    state.todos = todoRows
      .filter((row) => typeof row?.content === "string")
      .map((row) => ({ content: String(row.content), status: String(row.status ?? "pending") }))
  }

  state.source = transcript.source
  state.rows = buildTranscriptRows(transcript.messages.slice(-TRANSCRIPT_LIMIT), transcript.partsFor, {
    now: Date.now(),
  })
  const usage = contextUsage(transcript.messages)
  state.tokens = usage.tokens
  state.cost = usage.cost
  const provider = usage.providerID ? api.state.provider.find((item) => item.id === usage.providerID) : undefined
  const model = usage.modelID ? provider?.models[usage.modelID] : undefined
  state.contextLimit = model?.limit.context
  return state
}
