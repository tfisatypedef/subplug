export type TranscriptRow =
  | { kind: "text"; key: string; role: string; agent?: string; text: string }
  | { kind: "reasoning"; key: string; chars: number; preview?: string }
  | {
      kind: "tool"
      key: string
      tool: string
      status: string
      title?: string
      elapsedMs?: number
      outputTail?: string
      error?: string
    }
  | { kind: "file"; key: string; filename: string; mime?: string }
  | { kind: "patch"; key: string; files: number }
  | { kind: "agent"; key: string; name: string }
  | { kind: "retry"; key: string; attempt: number }
  | { kind: "compaction"; key: string; auto: boolean }
  | { kind: "step"; key: string; cost?: number; tokens?: number }
  | { kind: "other"; key: string; label: string }

export type TranscriptOptions = {
  now?: number
  maxTextChars?: number
  toolTailLines?: number
  toolTailChars?: number
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

export function outputTail(
  output: string | undefined,
  options: { maxLines?: number; maxChars?: number } = {},
): string | undefined {
  if (typeof output !== "string" || !output.trim()) return undefined
  const maxLines = options.maxLines ?? 2
  const maxChars = options.maxChars ?? 200
  const lines = output.replace(/\r\n/g, "\n").split("\n")
  const tail = lines.slice(-maxLines).join("\n").trim()
  if (!tail) return undefined
  return tail.length > maxChars ? `…${tail.slice(-(maxChars - 1))}` : tail
}

export type V2TokenUsage = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export type V2ToolContent = {
  type?: string
  text?: string
  uri?: string
  mime?: string
  name?: string
}

export type V2AssistantEntry = {
  type?: string
  id?: string
  name?: string
  text?: string
  state?: Record<string, unknown>
  metadata?: Record<string, unknown>
  time?: { created?: number; ran?: number; completed?: number }
  providerState?: unknown
  providerResultState?: unknown
}

export type V2Message = {
  id?: string
  type?: string
  time?: { created?: number; completed?: number; streamed?: number }
  text?: string
  description?: string
  agent?: string
  model?: { id?: string; providerID?: string; variant?: string }
  content?: V2AssistantEntry[]
  cost?: number
  tokens?: V2TokenUsage
  retry?: { attempt?: number }
  reason?: string
  status?: string
  command?: string
  skill?: string
  name?: string
  shellID?: string
}

function v2ToolStateText(state: Record<string, unknown> | undefined): string | undefined {
  if (!state) return undefined
  const content = Array.isArray(state.content) ? (state.content as V2ToolContent[]) : undefined
  if (!content?.length) return undefined
  const text = content
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text as string)
    .join("\n")
    .trim()
  return text || undefined
}

function v2ToolTitle(entry: V2AssistantEntry): string | undefined {
  const direct = typeof entry.state?.title === "string" ? entry.state.title : undefined
  if (direct) return direct
  const metadata = entry.state?.metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const title = (metadata as Record<string, unknown>).title
    if (typeof title === "string" && title.trim()) return title
  }
  return undefined
}

function v2ElapsedMs(entry: V2AssistantEntry, now: number): number | undefined {
  const time = entry.time
  if (!time) return undefined
  const start = typeof time.ran === "number" ? time.ran : time.created
  if (typeof start !== "number") return undefined
  const end = typeof time.completed === "number" ? time.completed : now
  return Math.max(0, end - start)
}

function v2StepTokens(message: V2Message): number | undefined {
  const tokens = message.tokens
  if (!tokens) return undefined
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

function v2ToolError(state: Record<string, unknown>): string | undefined {
  const error = state.error
  if (typeof error === "string") return error
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === "string" && message.trim()) return message
  }
  return undefined
}

/** v2 assistant messages embed content entries; user turns are a single text. */
export function buildTranscriptRowsV2(
  messages: readonly V2Message[],
  options: TranscriptOptions = {},
): TranscriptRow[] {
  const now = options.now ?? Date.now()
  const maxTextChars = options.maxTextChars ?? 1200
  const rows: TranscriptRow[] = []

  const pushText = (key: string, role: string, text: string | undefined, agent?: string): void => {
    const value = typeof text === "string" ? text.trim() : ""
    if (!value) return
    rows.push({ kind: "text", key, role, agent, text: truncate(value, maxTextChars) })
  }

  for (const message of messages) {
    const id = typeof message.id === "string" ? message.id : ""
    switch (message.type) {
      case "user":
      case "synthetic":
      case "system": {
        pushText(id, message.type, message.text)
        continue
      }
      case "skill": {
        pushText(id, "skill", message.name ?? message.skill)
        continue
      }
      case "agent-switched": {
        if (message.agent) rows.push({ kind: "agent", key: id, name: message.agent })
        continue
      }
      case "model-switched": {
        const model = message.model?.id
        if (model) rows.push({ kind: "other", key: id, label: `model ${model}` })
        continue
      }
      case "shell": {
        rows.push({ kind: "other", key: id, label: `shell ${message.status ?? "started"}` })
        continue
      }
      case "compaction": {
        const auto = message.reason === "auto"
        if (message.status === "failed") {
          rows.push({ kind: "other", key: id, label: "compaction failed" })
          continue
        }
        rows.push({ kind: "compaction", key: id, auto })
        const tokens = v2StepTokens(message)
        if (typeof message.cost === "number" || tokens !== undefined) {
          rows.push({ kind: "step", key: `${id}#step`, cost: message.cost, tokens })
        }
        continue
      }
      case "assistant": {
        const content = Array.isArray(message.content) ? message.content : []
        content.forEach((entry, index) => {
          const key = typeof entry.id === "string" ? entry.id : `${id}#${index}`
          switch (entry.type) {
            case "text": {
              pushText(key, "assistant", entry.text, message.agent)
              return
            }
            case "reasoning": {
              const text = typeof entry.text === "string" ? entry.text.trim() : ""
              if (!text) return
              rows.push({
                kind: "reasoning",
                key,
                chars: text.length,
                preview: truncate(text.replace(/\s+/g, " "), 120),
              })
              return
            }
            case "tool": {
              const state = entry.state ?? {}
              const status = typeof state.status === "string" ? state.status : "pending"
              rows.push({
                kind: "tool",
                key,
                tool: entry.name ?? "tool",
                status,
                title: v2ToolTitle(entry),
                elapsedMs: v2ElapsedMs(entry, now),
                outputTail: outputTail(v2ToolStateText(state), {
                  maxLines: options.toolTailLines,
                  maxChars: options.toolTailChars,
                }),
                error: v2ToolError(state),
              })
              return
            }
            default: {
              if (entry.type) rows.push({ kind: "other", key, label: entry.type })
            }
          }
        })
        if (message.retry?.attempt) {
          rows.push({ kind: "retry", key: `${id}#retry`, attempt: message.retry.attempt })
        }
        const tokens = v2StepTokens(message)
        if (typeof message.cost === "number" || tokens !== undefined) {
          rows.push({ kind: "step", key: `${id}#step`, cost: message.cost, tokens })
        }
        continue
      }
      default:
        continue
    }
  }
  return rows
}
