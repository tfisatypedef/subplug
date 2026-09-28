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
