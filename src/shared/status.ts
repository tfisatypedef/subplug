import type { SessionNode } from "./types.ts"

export const STATUS_GROUPS = {
  needs: { label: "Needs input", filter: "Needs you", mark: "●", color: "error", order: 0 },
  working: { label: "Working", filter: "Working", mark: "●", color: "success", order: 1 },
  ready: { label: "Ready", filter: "Ready", mark: "○", color: "accent", order: 2 },
  inactive: { label: "Inactive", filter: "Inactive", mark: "○", color: "muted", order: 3 },
} as const

export type StatusGroup = keyof typeof STATUS_GROUPS

export const SESSION_STATUS = {
  error: { group: "needs", mark: "✖", color: "error" },
  busy: { group: "working", mark: "●", color: "success" },
  retry: { group: "working", mark: "◌", color: "warning" },
  idle: { group: "ready", mark: "○", color: "muted" },
  unknown: { group: "inactive", mark: "·", color: "muted" },
} as const satisfies Record<SessionNode["status"], { group: StatusGroup; mark: string; color: string }>

export type TaskFilter = {
  label: string
  group: StatusGroup | null
}

export const TASK_FILTERS: readonly TaskFilter[] = [
  { label: "All", group: null },
  ...Object.entries(STATUS_GROUPS).map(([group, value]) => ({ label: value.filter, group: group as StatusGroup })),
]

export function statusGroup(session: SessionNode, needsInput = false): StatusGroup {
  if (needsInput) return "needs"
  if (session.deleted) return "inactive"
  return SESSION_STATUS[session.status].group
}

export function statusGroupLabel(group: StatusGroup): string {
  return STATUS_GROUPS[group].label
}
