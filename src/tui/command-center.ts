import type { SessionNode } from "../shared/types.ts"
import { buildSessionTree, flattenTree } from "../hub/tree.ts"

export type StatusGroup = "needs" | "working" | "ready" | "inactive"

export type TaskFilter = {
  label: string
  group: StatusGroup | null
}

export const TASK_FILTERS: readonly TaskFilter[] = [
  { label: "All", group: null },
  { label: "Needs you", group: "needs" },
  { label: "Working", group: "working" },
  { label: "Ready", group: "ready" },
  { label: "Inactive", group: "inactive" },
]

const GROUP_ORDER: Record<StatusGroup, number> = { needs: 0, working: 1, ready: 2, inactive: 3 }

export function statusGroup(session: SessionNode, needsInput = false): StatusGroup {
  if (needsInput) return "needs"
  if (session.deleted) return "inactive"
  switch (session.status) {
    case "error":
      return "needs"
    case "busy":
    case "retry":
      return "working"
    case "idle":
      return "ready"
    default:
      return "inactive"
  }
}

export function statusGroupLabel(group: StatusGroup): string {
  switch (group) {
    case "needs":
      return "Needs input"
    case "working":
      return "Working"
    case "ready":
      return "Ready"
    case "inactive":
      return "Inactive"
  }
}

export function filterCounts(
  sessions: readonly SessionNode[],
  needsInput: ReadonlySet<string> = new Set(),
): number[] {
  return TASK_FILTERS.map((filter) =>
    filter.group === null
      ? sessions.length
      : sessions.filter((session) => statusGroup(session, needsInput.has(session.sessionID)) === filter.group)
          .length,
  )
}

export type Grouping = "project" | "status" | "agent" | "hierarchy"

export const GROUPINGS: readonly Grouping[] = ["project", "status", "agent", "hierarchy"]

export function groupingLabel(grouping: Grouping): string {
  return grouping.charAt(0).toUpperCase() + grouping.slice(1)
}

export function nextGrouping(grouping: Grouping): Grouping {
  const index = GROUPINGS.indexOf(grouping)
  return GROUPINGS[(index + 1) % GROUPINGS.length] ?? "project"
}

export function isGrouping(value: unknown): value is Grouping {
  return typeof value === "string" && (GROUPINGS as readonly string[]).includes(value)
}

export type TaskRow = {
  session: SessionNode
  depth: number
  orphan: boolean
  hasChildren: boolean
  collapsed: boolean
}

export type CenterRow =
  | { kind: "group"; key: string; label: string; count: number }
  | { kind: "gap"; key: string }
  | { kind: "task"; task: TaskRow }

export type CenterRows = {
  rows: CenterRow[]
  tasks: TaskRow[]
}

export type BuildCenterOptions = {
  filter: StatusGroup | null
  search: string
  grouping: Grouping
  collapsed?: ReadonlySet<string>
  needsInput?: ReadonlySet<string>
}

function recencyDesc(a: SessionNode, b: SessionNode): number {
  return b.lastEventAt - a.lastEventAt || a.sessionID.localeCompare(b.sessionID)
}

function searchable(session: SessionNode): string {
  return `${session.title ?? ""} ${session.sessionID} ${session.agent ?? ""} ${session.directory ?? ""}`.toLowerCase()
}

type Bucket = {
  key: string
  label: string
  sort: number | string
  tasks: SessionNode[]
}

export function buildCenterRows(
  sessions: readonly SessionNode[],
  options: BuildCenterOptions,
): CenterRows {
  const needs = options.needsInput ?? new Set<string>()
  const search = options.search.trim().toLowerCase()
  const filtered = sessions.filter((session) => {
    if (options.filter !== null && statusGroup(session, needs.has(session.sessionID)) !== options.filter) return false
    if (!search) return true
    return searchable(session).includes(search)
  })

  if (options.grouping === "hierarchy") {
    const tree = buildSessionTree([...filtered])
    const flat = flattenTree(tree, options.collapsed ?? new Set())
    const tasks: TaskRow[] = flat.map((row) => ({
      session: row.session,
      depth: row.depth,
      orphan: row.orphan,
      hasChildren: row.hasChildren,
      collapsed: row.collapsed,
    }))
    return { rows: tasks.map((task) => ({ kind: "task", task }) as CenterRow), tasks }
  }

  const buckets = new Map<string, Bucket>()
  const bucketFor = (session: SessionNode): Bucket => {
    if (options.grouping === "project") {
      const key = session.directory ?? "(unknown directory)"
      return { key, label: key, sort: key, tasks: [] }
    }
    if (options.grouping === "agent") {
      const key = session.agent ?? "(no agent)"
      return { key, label: key, sort: key, tasks: [] }
    }
    const group = statusGroup(session, needs.has(session.sessionID))
    return { key: group, label: statusGroupLabel(group), sort: GROUP_ORDER[group], tasks: [] }
  }
  for (const session of filtered) {
    const bucket = bucketFor(session)
    const existing = buckets.get(bucket.key)
    if (existing) existing.tasks.push(session)
    else {
      bucket.tasks.push(session)
      buckets.set(bucket.key, bucket)
    }
  }

  const ordered = [...buckets.values()].sort((a, b) =>
    typeof a.sort === "number" && typeof b.sort === "number"
      ? a.sort - b.sort
      : String(a.sort).localeCompare(String(b.sort)),
  )

  const rows: CenterRow[] = []
  const tasks: TaskRow[] = []
  ordered.forEach((bucket, index) => {
    if (index > 0) rows.push({ kind: "gap", key: `gap:${bucket.key}` })
    rows.push({ kind: "group", key: `group:${bucket.key}`, label: bucket.label, count: bucket.tasks.length })
    for (const session of [...bucket.tasks].sort(recencyDesc)) {
      const task: TaskRow = { session, depth: 0, orphan: false, hasChildren: false, collapsed: false }
      tasks.push(task)
      rows.push({ kind: "task", task })
    }
  })
  return { rows, tasks }
}

export function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, value))
}

export function taskPositions(rows: readonly CenterRow[]): number[] {
  const positions: number[] = []
  rows.forEach((row, index) => {
    if (row.kind === "task") positions.push(index)
  })
  return positions
}

export function selectedDisplayIndex(rows: readonly CenterRow[], selectedTask: number): number {
  const positions = taskPositions(rows)
  if (!positions.length) return -1
  return positions[clampIndex(selectedTask, positions.length)] ?? -1
}

export function taskIndexByDisplay(rows: readonly CenterRow[]): number[] {
  let task = 0
  return rows.map((row) => (row.kind === "task" ? task++ : -1))
}

export function clampWindow(rowCount: number, displayIndex: number, height: number): number {
  if (height <= 0 || rowCount <= height) return 0
  const half = Math.floor(height / 2)
  return Math.max(0, Math.min(rowCount - height, displayIndex - half))
}

export type MarqueeTarget = {
  readonly width: number
  readonly scrollWidth: number
  scrollX: number
}

export type MarqueeStep = {
  offset: number
  direction: 1 | -1
}

export function marqueeStep(offset: number, max: number, direction: 1 | -1): MarqueeStep {
  if (max <= 0) return { offset: 0, direction: 1 }
  let next = offset + direction
  let nextDirection = direction
  if (next >= max) {
    next = max
    nextDirection = -1
  } else if (next <= 0) {
    next = 0
    nextDirection = 1
  }
  return { offset: next, direction: nextDirection }
}

export type Marquee = {
  start: () => void
  stop: () => void
  readonly active: boolean
}

export function createMarquee(
  getTarget: () => MarqueeTarget | undefined,
  options: { intervalMs?: number } = {},
): Marquee {
  const intervalMs = options.intervalMs ?? 120
  let timer: ReturnType<typeof setInterval> | undefined
  let offset = 0
  let direction: 1 | -1 = 1

  const reset = () => {
    offset = 0
    direction = 1
    const target = getTarget()
    if (target) target.scrollX = 0
  }

  const start = () => {
    if (timer) return
    timer = setInterval(() => {
      const target = getTarget()
      if (!target) return
      const max = Math.max(0, Math.floor(target.scrollWidth - target.width))
      const next = marqueeStep(offset, max, direction)
      offset = next.offset
      direction = next.direction
      target.scrollX = offset
    }, intervalMs)
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
    reset()
  }

  return {
    start,
    stop,
    get active() {
      return timer !== undefined
    },
  }
}
