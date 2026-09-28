import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
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
      rmSync(rotated, { force: true })
      renameSync(file, rotated)
    } catch {
      // rotation is best-effort; keep appending if the rename fails
    }
  }
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
  options: { maxAgeMs?: number; maxRecords?: number; now?: number } = {},
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
  for (const name of names.sort()) {
    if (!isEventsFile(name)) continue
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

export function isEventRecord(value: unknown): value is EventRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.ts === "number" && typeof record.kind === "string" && typeof record.serverID === "string"
}
