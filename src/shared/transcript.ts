export type TranscriptTokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export type TranscriptMessage = {
  id: string
  role: string
  agent?: string
  model?: string
  providerID?: string
  cost?: number
  tokens?: TranscriptTokens
  time?: { created?: number; completed?: number }
}

export type TranscriptToolState = {
  status?: string
  title?: string
  input?: unknown
  output?: string
  error?: string
  time?: { start?: number; end?: number }
}

export type TranscriptPart = {
  id?: string
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: TranscriptToolState
  filename?: string
  mime?: string
  url?: string
  files?: string[]
  hash?: string
  name?: string
  auto?: boolean
  attempt?: number
  cost?: number
  tokens?: TranscriptTokens
}

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

export function elapsedMs(part: { state?: TranscriptToolState }, now = Date.now()): number | undefined {
  const start = part.state?.time?.start
  if (typeof start !== "number") return undefined
  const end = part.state?.time?.end
  return Math.max(0, (typeof end === "number" ? end : now) - start)
}

function stepTokens(part: TranscriptPart): number | undefined {
  const tokens = part.tokens
  if (!tokens) return undefined
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

export function buildTranscriptRows(
  messages: readonly TranscriptMessage[],
  partsFor: (messageID: string) => readonly TranscriptPart[],
  options: TranscriptOptions = {},
): TranscriptRow[] {
  const now = options.now ?? Date.now()
  const maxTextChars = options.maxTextChars ?? 1200
  const rows: TranscriptRow[] = []

  for (const message of messages) {
    const parts = partsFor(message.id)
    parts.forEach((part, index) => {
      const key = part.id ?? `${message.id}#${index}`
      switch (part.type) {
        case "text": {
          const text = typeof part.text === "string" ? part.text.trim() : ""
          if (!text) return
          rows.push({
            kind: "text",
            key,
            role: message.role,
            agent: message.agent,
            text: truncate(text, maxTextChars),
          })
          return
        }
        case "reasoning": {
          const text = typeof part.text === "string" ? part.text.trim() : ""
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
          const state = part.state ?? {}
          rows.push({
            kind: "tool",
            key,
            tool: part.tool ?? "tool",
            status: state.status ?? "pending",
            title: state.title,
            elapsedMs: elapsedMs(part, now),
            outputTail: outputTail(state.output, {
              maxLines: options.toolTailLines,
              maxChars: options.toolTailChars,
            }),
            error: state.error,
          })
          return
        }
        case "file": {
          rows.push({ kind: "file", key, filename: part.filename ?? part.url ?? "file", mime: part.mime })
          return
        }
        case "patch": {
          rows.push({ kind: "patch", key, files: Array.isArray(part.files) ? part.files.length : 0 })
          return
        }
        case "agent": {
          rows.push({ kind: "agent", key, name: part.name ?? "agent" })
          return
        }
        case "retry": {
          rows.push({ kind: "retry", key, attempt: typeof part.attempt === "number" ? part.attempt : 0 })
          return
        }
        case "compaction": {
          rows.push({ kind: "compaction", key, auto: part.auto === true })
          return
        }
        case "step-finish": {
          rows.push({ kind: "step", key, cost: part.cost, tokens: stepTokens(part) })
          return
        }
        case "step-start":
        case "snapshot":
        case "subtask":
          return
        default: {
          rows.push({ kind: "other", key, label: part.type })
        }
      }
    })
  }
  return rows
}
