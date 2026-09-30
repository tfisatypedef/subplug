import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs"
import type { EventRecord } from "../shared/types.ts"
import { eventsFile, isEventsFile, rotatedEventsFile } from "./paths.ts"

export const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_RECORDS = 50_000

export class EventLog {
  readonly hubDir: string
  readonly serverID: string
  private readonly maxBytes: number

  constructor(hubDir: string, serverID: string, maxBytes: number = DEFAULT_MAX_LOG_BYTES) {
    this.hubDir = hubDir
    this.serverID = serverID
    this.maxBytes = maxBytes
    mkdirSync(hubDir, { recursive: true })
  }

  file(): string {
    return eventsFile(this.hubDir, this.serverID)
  }

  append(record: EventRecord): void {
    const line = `${JSON.stringify(record)}\n`
    const data = Buffer.from(line, "utf8")
    this.rotateIfNeeded(data.byteLength)
    const descriptor = openSync(this.file(), "a")
    try {
      writeSync(descriptor, data)
    } finally {
      closeSync(descriptor)
    }
  }

  private rotateIfNeeded(incoming: number): void {
    const file = this.file()
    if (!existsSync(file)) return
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (size + incoming <= this.maxBytes) return
    const rotated = rotatedEventsFile(this.hubDir, this.serverID)
    try {
      // Each writer checkpoints only its own discarded segment. Keep original
      // event timestamps/fields so another writer's newer updates win on replay.
      if (existsSync(rotated)) {
        const checkpoint = `${file}.checkpoint`
        const records = compactSessionRecords([
          ...readRecordsFile(checkpoint), ...readRecordsFile(rotated),
        ])
        const temporary = `${checkpoint}.tmp`
        writeFileSync(temporary, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
        renameSync(temporary, checkpoint)
      }
      rmSync(rotated, { force: true })
      renameSync(file, rotated)
    } catch {
      // rotation is best-effort; keep appending if the rename fails
    }
  }
}

function readRecordsFile(path: string): EventRecord[] {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return isEventRecord(value) ? [value] : []
      } catch { return [] }
    })
  } catch { return [] }
}

// Retain the latest source event for every folded field, plus last activity.
// Keeping complete original records also preserves initial-created semantics.
function compactSessionRecords(records: EventRecord[]): EventRecord[] {
  const fields = new Map<string, EventRecord>()
  const ordered = records.sort((a, b) => a.ts - b.ts)
  for (const record of ordered) {
    if (record.kind.startsWith("comms.")) continue
    const id = record.sessionID ?? (typeof record.refs?.sessionID === "string" ? record.refs.sessionID : undefined)
    if (!id) continue
    const keys = ["activity"]
    const lifecycle = ["session.created", "session.updated", "session.deleted"].includes(record.kind)
    if (lifecycle && record.parentID) keys.push("parentID")
    const metadata = lifecycle ? ["parentID", "title", "directory", "agent", "model", "cost"]
      : record.kind === "session.identity" ? ["identity"]
        : record.kind === "session.agent" ? ["agent"]
          : record.kind === "session.model" ? ["model"] : []
    for (const key of metadata) {
      const value = record.refs?.[key]
      if (typeof value === "string" && value || key === "cost" && typeof value === "number" && Number.isFinite(value)) keys.push(key)
    }
    if (["session.status", "session.idle", "session.error"].includes(record.kind)) keys.push("status")
    if (record.kind === "session.created") keys.push("created")
    if (record.kind === "session.deleted") keys.push("deleted")
    if (record.kind === "session.error") keys.push("errorAt")
    for (const key of keys) fields.set(`${id}\0${key}`, record)
  }
  const retained = new Set(fields.values())
  return ordered.filter((record) => retained.has(record))
}

function orderedFiles(names: string[], checkpoints = false): string[] {
  return names.filter((name) => isEventsFile(name) || checkpoints && name.startsWith("events.") && name.endsWith(".jsonl.checkpoint"))
    .sort((a, b) => {
      const base = (name: string) => name.replace(/\.(1|checkpoint)$/, "")
      const rank = (name: string) => name.endsWith(".checkpoint") ? 0 : name.endsWith(".1") ? 1 : 2
      return base(a).localeCompare(base(b)) || rank(a) - rank(b)
    })
}

export function readSessionRecords(hubDir: string): EventRecord[] {
  let names: string[]
  try { names = readdirSync(hubDir) } catch { return [] }
  let retained: EventRecord[] = []
  for (const name of orderedFiles(names, true)) {
    // Reduce each segment before reading the next. Memory scales with folded
    // session fields plus one segment, rather than all retained event history.
    retained = compactSessionRecords([...retained, ...readRecordsFile(`${hubDir}/${name}`)])
  }
  return retained
}

type RankedRecord = { ts: number; seq: number; record: EventRecord }

function compareRanked(a: RankedRecord, b: RankedRecord): number {
  return a.ts - b.ts || a.seq - b.seq
}

class NewestRecords {
  private readonly entries: RankedRecord[] = []

  constructor(private readonly limit: number) {}

  push(record: EventRecord, seq: number): void {
    if (this.limit <= 0) return
    const entry: RankedRecord = { ts: record.ts, seq, record }
    if (this.entries.length < this.limit) {
      this.entries.push(entry)
      this.bubbleUp(this.entries.length - 1)
      return
    }
    const smallest = this.entries[0]
    if (smallest && compareRanked(entry, smallest) > 0) {
      this.entries[0] = entry
      this.sinkDown(0)
    }
  }

  values(): EventRecord[] {
    return [...this.entries]
      .sort((a, b) => compareRanked(a, b))
      .map((entry) => entry.record)
  }

  private bubbleUp(index: number): void {
    let current = index
    while (current > 0) {
      const parent = (current - 1) >> 1
      const child = this.entries[current]
      const above = this.entries[parent]
      if (!child || !above || compareRanked(child, above) >= 0) break
      this.entries[current] = above
      this.entries[parent] = child
      current = parent
    }
  }

  private sinkDown(index: number): void {
    let current = index
    for (;;) {
      const left = current * 2 + 1
      const right = left + 1
      let smallest = current
      const currentEntry = this.entries[smallest]
      const leftEntry = this.entries[left]
      if (leftEntry && currentEntry && compareRanked(leftEntry, currentEntry) < 0) smallest = left
      const smallestEntry = this.entries[smallest]
      const rightEntry = this.entries[right]
      if (rightEntry && smallestEntry && compareRanked(rightEntry, smallestEntry) < 0) smallest = right
      if (smallest === current || !currentEntry) return
      const swapped = this.entries[smallest]
      if (!swapped) return
      this.entries[smallest] = currentEntry
      this.entries[current] = swapped
      current = smallest
    }
  }
}

export function readEventRecords(
  hubDir: string,
  options: { maxAgeMs?: number; maxRecords?: number; now?: number; includeCheckpoints?: boolean } = {},
): EventRecord[] {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  const now = options.now ?? Date.now()
  if (maxRecords <= 0) return []
  let names: string[]
  try {
    names = readdirSync(hubDir)
  } catch {
    return []
  }

  const newest = new NewestRecords(maxRecords)
  let seq = 0
  for (const name of orderedFiles(names, options.includeCheckpoints)) {
    let text: string
    try {
      text = readFileSync(`${hubDir}/${name}`, "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isEventRecord(parsed)) continue
      if (options.maxAgeMs !== undefined && now - parsed.ts > options.maxAgeMs) continue
      newest.push(parsed, seq)
      seq += 1
    }
  }

  return newest.values()
}

export type EventTailCursor = { offset: number; identity: string }

function fileIdentity(stats: { dev: number; ino: number; birthtimeMs: number }): string {
  return stats.ino === 0 ? `birth:${stats.birthtimeMs}` : `dev:${stats.dev}:ino:${stats.ino}`
}

export class EventTail {
  private readonly cursors = new Map<string, EventTailCursor>()

  seed(hubDir: string): void {
    let names: string[]
    try {
      names = readdirSync(hubDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!isEventsFile(name)) continue
      try {
        const stats = statSync(`${hubDir}/${name}`)
        this.cursors.set(name, { offset: stats.size, identity: fileIdentity(stats) })
      } catch {
        // a missing file will be read from the start when it appears
      }
    }
  }

  read(hubDir: string): EventRecord[] {
    let names: string[]
    try {
      names = readdirSync(hubDir)
    } catch {
      return []
    }
    const records: EventRecord[] = []
    for (const name of orderedFiles(names)) {
      records.push(...this.readFile(hubDir, name))
    }
    return records
  }

  private readFile(hubDir: string, name: string): EventRecord[] {
    const path = `${hubDir}/${name}`
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(path)
    } catch {
      return []
    }
    const identity = fileIdentity(stats)
    let cursor = this.cursors.get(name)
    if (!cursor || cursor.identity !== identity || stats.size < cursor.offset) {
      cursor = { offset: 0, identity }
    }
    if (cursor.offset >= stats.size) {
      this.cursors.set(name, cursor)
      return []
    }

    let descriptor: number
    try {
      descriptor = openSync(path, "r")
    } catch {
      return []
    }
    try {
      const buffer = Buffer.alloc(stats.size - cursor.offset)
      let filled = 0
      while (filled < buffer.length) {
        const bytes = readSync(descriptor, buffer, filled, buffer.length - filled, cursor.offset + filled)
        if (bytes <= 0) break
        filled += bytes
      }
      const complete = buffer.subarray(0, filled)
      const lastNewline = complete.lastIndexOf(0x0a)
      if (lastNewline === -1) {
        this.cursors.set(name, cursor)
        return []
      }
      const records: EventRecord[] = []
      for (const line of complete.subarray(0, lastNewline).toString("utf8").split("\n")) {
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (isEventRecord(parsed)) records.push(parsed)
      }
      this.cursors.set(name, { offset: cursor.offset + lastNewline + 1, identity })
      return records
    } catch {
      return []
    } finally {
      closeSync(descriptor)
    }
  }
}

export function isEventRecord(value: unknown): value is EventRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.ts === "number" && typeof record.kind === "string" && typeof record.serverID === "string"
}
