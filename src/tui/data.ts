import type { EventRecord } from "../shared/types.ts"
import { buildTranscriptRowsV2, type TranscriptRow, type V2Message } from "../shared/transcript.ts"

export type V2SessionInfo = {
  id?: string
  parentID?: string
  title?: string
  agent?: string
  model?: { id?: string; providerID?: string; variant?: string }
  cost?: number
  time?: { created?: number; updated?: number }
  location?: { directory?: string }
}

export type V2ModelInfo = {
  id?: string
  limit?: { context?: number }
}

export type TuiDataContext = {
  readonly data: {
    readonly session: {
      list: () => V2SessionInfo[] | undefined
      get: (sessionID: string) => V2SessionInfo | undefined
      readonly message: {
        list: (sessionID: string) => V2Message[]
        sync: (sessionID: string) => Promise<void>
      }
      readonly permission?: { list: (sessionID: string) => unknown[] | undefined }
      readonly form?: { list: (sessionID: string) => unknown[] | undefined }
    }
    readonly location?: {
      readonly model?: { list: () => V2ModelInfo[] | undefined }
    }
  }
  readonly client: {
    readonly session: {
      context: (input: { sessionID: string }) => Promise<unknown>
      list?: (input?: { limit?: number }) => Promise<unknown>
    }
  }
}

export type TranscriptSourceV2 = {
  source: "store" | "client" | "none"
  messages: V2Message[]
}

export type SessionDetailV2 = {
  rows: TranscriptRow[]
  tokens: number
  cost: number
  contextLimit?: number
  todos: Array<{ content: string; status: string }>
  source: TranscriptSourceV2["source"]
}

const TRANSCRIPT_LIMIT = 60

function unwrapData<T>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") return undefined
  const data = (response as { data?: T }).data
  return data === undefined ? (response as T) : data
}

/** The v2 store is authoritative once synced; the native context endpoint is the fallback. */
export async function loadTranscriptV2(ctx: TuiDataContext, sessionID: string): Promise<TranscriptSourceV2> {
  try {
    await ctx.data.session.message.sync(sessionID)
  } catch {
    // the store may be unavailable during bootstrap
  }
  const stored = ctx.data.session.message.list(sessionID)
  if (Array.isArray(stored) && stored.length) {
    return { source: "store", messages: stored }
  }
  try {
    const rows = unwrapData<unknown>(await ctx.client.session.context({ sessionID }))
    if (Array.isArray(rows) && rows.length) {
      return { source: "client", messages: rows as V2Message[] }
    }
  } catch {
    // fall through to an empty transcript
  }
  return { source: "none", messages: [] }
}

function contextUsage(messages: readonly V2Message[]): {
  tokens: number
  cost: number
  modelID?: string
  providerID?: string
} {
  let tokens = 0
  let cost = 0
  let modelID: string | undefined
  let providerID: string | undefined
  for (const message of messages) {
    if (message.type !== "assistant") continue
    cost += message.cost ?? 0
    const input = (message.tokens?.input ?? 0) + (message.tokens?.cache?.read ?? 0)
    if (input > tokens) {
      tokens = input
      modelID = message.model?.id
      providerID = message.model?.providerID
    }
  }
  return { tokens, cost, modelID, providerID }
}

export async function loadSessionDetailV2(
  ctx: TuiDataContext,
  sessionID: string,
  options: { now?: number } = {},
): Promise<SessionDetailV2> {
  const transcript = await loadTranscriptV2(ctx, sessionID)
  const recent = transcript.messages.slice(-TRANSCRIPT_LIMIT)
  const usage = contextUsage(recent)
  const contextLimit = usage.modelID
    ? ctx.data.location?.model?.list()?.find((model) => model.id === usage.modelID)?.limit?.context
    : undefined
  return {
    rows: buildTranscriptRowsV2(recent, { now: options.now ?? Date.now() }),
    tokens: usage.tokens,
    cost: usage.cost,
    contextLimit,
    todos: [],
    source: transcript.source,
  }
}

export async function listNativeSessions(ctx: TuiDataContext): Promise<V2SessionInfo[]> {
  if (!ctx.client.session.list) return []
  try {
    const response = await ctx.client.session.list({ limit: 200 })
    const outer = unwrapData<unknown>(response)
    if (Array.isArray(outer)) return outer as V2SessionInfo[]
    const inner = unwrapData<unknown>(outer)
    if (Array.isArray(inner)) return inner as V2SessionInfo[]
  } catch {
    // backfill is best-effort
  }
  return []
}

/**
 * The server plugin activates lazily, so a session created at the same moment as
 * activation may miss `session.created`. The TUI can enumerate native sessions
 * and write the missing creation records into the shared hub.
 */
export function backfillSessions(
  known: ReadonlySet<string>,
  sessions: readonly V2SessionInfo[],
  append: (record: EventRecord) => void,
  serverID: string,
  now = Date.now(),
): number {
  let written = 0
  for (const session of sessions) {
    const sessionID = typeof session.id === "string" ? session.id : undefined
    if (!sessionID || known.has(sessionID)) continue
    append({
      ts: now,
      serverID,
      sessionID,
      parentID: session.parentID,
      kind: "session.created",
      refs: {
        title: session.title ?? null,
        directory: session.location?.directory ?? null,
        parentID: session.parentID ?? null,
        agent: session.agent ?? null,
        model: session.model?.id ?? null,
        cost: typeof session.cost === "number" && Number.isFinite(session.cost) ? session.cost : null,
      },
    })
    written += 1
  }
  return written
}

export function sessionNeedsInput(ctx: TuiDataContext, sessionID: string): boolean {
  try {
    const permission = ctx.data.session.permission?.list(sessionID) ?? []
    const form = ctx.data.session.form?.list(sessionID) ?? []
    return permission.length > 0 || form.length > 0
  } catch {
    return false
  }
}
