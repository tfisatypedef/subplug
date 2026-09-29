import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const EVENTS_PREFIX = "events."
export const EVENTS_SUFFIX = ".jsonl"
export const SNAPSHOT_FILE = "snapshot.json"

export function sanitizeProjectID(projectID: string): string {
  const safe = projectID
    .replace(/[^A-Za-z0-9._@-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/[. ]+$/g, "")
  return safe && safe !== "." && safe !== ".." ? safe : "unknown"
}

export function hubRoot(stateDir: string, projectID: string): string {
  return join(stateDir, "subplug", sanitizeProjectID(projectID))
}

export function eventsFile(hubDir: string, serverID: string): string {
  return join(hubDir, `${EVENTS_PREFIX}${serverID}${EVENTS_SUFFIX}`)
}

export function rotatedEventsFile(hubDir: string, serverID: string): string {
  return `${eventsFile(hubDir, serverID)}.1`
}

export function snapshotFile(hubDir: string): string {
  return join(hubDir, SNAPSHOT_FILE)
}

export function isEventsFile(name: string): boolean {
  return name.startsWith(EVENTS_PREFIX) && (name.endsWith(EVENTS_SUFFIX) || name.endsWith(`${EVENTS_SUFFIX}.1`))
}

export function fallbackStateDir(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state")
  return join(base, "opencode")
}

export const HUB_POINTER_FILE = "hub.json"
export const HUB_POINTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type HubPointer = {
  hubDir: string
  group?: string
  at: number
}

export function hubPointerFile(): string {
  return join(fallbackStateDir(), "subplug", HUB_POINTER_FILE)
}

/**
 * The server plugin and the TUI entry receive plugin options separately, so a
 * `storageDir` option reaches the server only. The server records the resolved
 * hub here for the TUI to read.
 */
export function writeHubPointer(pointer: HubPointer): void {
  const file = hubPointerFile()
  mkdirSync(join(fallbackStateDir(), "subplug"), { recursive: true })
  writeFileSync(file, `${JSON.stringify(pointer)}\n`, "utf8")
}

export function readHubPointer(now = Date.now(), maxAgeMs = HUB_POINTER_MAX_AGE_MS): HubPointer | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(hubPointerFile(), "utf8"))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.hubDir !== "string" || !record.hubDir) return undefined
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return undefined
  if (maxAgeMs > 0 && now - record.at > maxAgeMs) return undefined
  return {
    hubDir: record.hubDir,
    group: typeof record.group === "string" ? record.group : undefined,
    at: record.at,
  }
}
