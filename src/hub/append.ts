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

export function readEventRecords(
  hubDir: string,
  options: { maxAgeMs?: number; maxRecords?: number; now?: number } = {},
): EventRecord[] {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  const now = options.now ?? Date.now()
  let names: string[]
  try {
    names = readdirSync(hubDir)
  } catch {
    return []
  }

  const records: EventRecord[] = []
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
      records.push(parsed)
      if (records.length >= maxRecords) break
    }
    if (records.length >= maxRecords) break
  }

  records.sort((a, b) => a.ts - b.ts)
  return records
}

export function isEventRecord(value: unknown): value is EventRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.ts === "number" && typeof record.kind === "string" && typeof record.serverID === "string"
}
