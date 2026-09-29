import type { SessionNode } from "../shared/types.ts"
import { buildSessionTree, flattenTree } from "../hub/tree.ts"
import {
  STATUS_GROUPS,
  SESSION_STATUS,
  TASK_FILTERS,
  statusGroup,
  statusGroupLabel,
} from "../shared/status.ts"
import type { StatusGroup, TaskFilter } from "../shared/status.ts"

export { STATUS_GROUPS, SESSION_STATUS, TASK_FILTERS, statusGroup, statusGroupLabel }
export type { StatusGroup, TaskFilter }

export type CenterState = {
  groups: ReadonlyMap<string, StatusGroup>
  collapsed: ReadonlySet<string>
}

export function centerState(
  sessions: readonly SessionNode[],
  needs: (sessionID: string) => boolean = () => false,
  collapsed: ReadonlySet<string> = new Set(),
): CenterState {
  return {
    groups: new Map(sessions.map((session) => [session.sessionID, statusGroup(session, needs(session.sessionID))])),
    collapsed,
  }
}

function groupFor(session: SessionNode, state: CenterState): StatusGroup {
  return state.groups.get(session.sessionID) ?? statusGroup(session)
}

export function filterCounts(
  sessions: readonly SessionNode[],
  state: CenterState = centerState(sessions),
): number[] {
  return TASK_FILTERS.map((filter) =>
    filter.group === null
      ? sessions.length
      : sessions.filter((session) => groupFor(session, state) === filter.group)
          .length,
  )
}

export const GROUPINGS = ["project", "status", "agent", "hierarchy"] as const

export type Grouping = (typeof GROUPINGS)[number]

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
  group: StatusGroup
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
  state?: CenterState
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
  const state = options.state ?? centerState(sessions)
  const search = options.search.trim().toLowerCase()
  const filtered = sessions.filter((session) => {
    if (options.filter !== null && groupFor(session, state) !== options.filter) return false
    if (!search) return true
    return searchable(session).includes(search)
  })

  if (options.grouping === "hierarchy") {
    const tree = buildSessionTree([...filtered])
    const flat = flattenTree(tree, state.collapsed)
    const tasks: TaskRow[] = flat.map((row) => ({
      session: row.session,
      group: groupFor(row.session, state),
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
    const group = groupFor(session, state)
    return { key: group, label: statusGroupLabel(group), sort: STATUS_GROUPS[group].order, tasks: [] }
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
      const task: TaskRow = {
        session,
        group: groupFor(session, state),
        depth: 0,
        orphan: false,
        hasChildren: false,
        collapsed: false,
      }
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
