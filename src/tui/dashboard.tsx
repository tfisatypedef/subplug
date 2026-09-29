/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Show } from "solid-js"
import type { MonitorState, SessionNode } from "../shared/types.ts"
import { rollupSubtree } from "../hub/tree.ts"
import { sessionNeedsInput } from "./data.ts"
import { age, groupColor, groupMark, rollupLabel, sessionLabel, skinForTheme } from "./presentation.ts"
import { registerDashboardKeys } from "./dashboard-keys.ts"
import { DetailsPane } from "./details-pane.tsx"
import type { TuiContextLike } from "./context.ts"
import {
  buildCenterRows,
  centerState,
  clampIndex,
  clampWindow,
  filterCounts,
  groupingLabel,
  isGrouping,
  nextGrouping,
  selectedDisplayIndex,
  statusGroupLabel,
  taskIndexByDisplay,
  TASK_FILTERS,
  type Grouping,
  type TaskRow,
} from "./command-center.ts"

const PREFERENCES_KEY = "preferences"

function padEnd(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : `${value}${" ".repeat(width - value.length)}`
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : `${" ".repeat(width - value.length)}${value}`
}

function squish(value: string, width: number): string {
  if (value.length <= width) return value
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`
}

export function Dashboard(props: {
  ctx: TuiContextLike
  state: () => MonitorState
  currentSession?: () => string | undefined
  onClose: () => void
  openSession: (sessionID: string) => void
  compose: (sessionID: string, status: SessionNode["status"]) => void
}) {
  const snapshot = () => props.state()
  const skin = () => skinForTheme(props.ctx.theme)
  const sessions = () => snapshot().sessions
  const width = () => props.ctx.renderer?.width ?? 120
  const [preferences, updatePreferences] = props.ctx.storage.store(PREFERENCES_KEY, {
    initial: { collapsed: [] as string[], grouping: "project" as string },
  })
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set(preferences.collapsed))
  const [filterIndex, setFilterIndex] = createSignal(0)
  const [grouping, setGrouping] = createSignal<Grouping>(isGrouping(preferences.grouping) ? preferences.grouping : "project")
  const [selectedTask, setSelectedTask] = createSignal(0)
  const [help, setHelp] = createSignal(false)
  const [search, setSearch] = createSignal("")

  const view = createMemo(() => centerState(sessions(), (id) => sessionNeedsInput(props.ctx, id), collapsed()))
  const counts = createMemo(() => filterCounts(sessions(), view()))
  const listing = createMemo(() =>
    buildCenterRows(sessions(), {
      filter: TASK_FILTERS[filterIndex()]?.group ?? null,
      search: search(),
      grouping: grouping(),
      state: view(),
    }),
  )
  const rows = () => listing().rows
  const tasks = () => listing().tasks
  const displayIndex = () => selectedDisplayIndex(rows(), selectedTask())
  const viewport = () => Math.max(3, (props.ctx.renderer?.height ?? 24) - 9 - (search() ? 1 : 0))
  const start = () => clampWindow(rows().length, Math.max(0, displayIndex()), viewport())
  const visible = () => rows().slice(start(), start() + viewport())
  const selected = () => tasks()[clampIndex(selectedTask(), tasks().length)]
  const currentID = () => props.currentSession?.()
  const wide = () => width() >= 90
  const listWidth = () => (wide() ? Math.max(24, width() - 44) : Math.max(16, width() - 4))
  const showStatus = () => listWidth() >= 56
  const titleWidth = () => Math.max(8, listWidth() - 5 - (showStatus() ? 11 : 0) - 9)

  const persist = (patch: { collapsed?: string[]; grouping?: Grouping }): void => {
    void updatePreferences((draft) => {
      if (patch.collapsed) draft.collapsed = patch.collapsed
      if (patch.grouping) draft.grouping = patch.grouping
    })
  }
  const move = (delta: number) => {
    const total = tasks().length
    if (!total) return
    setSelectedTask(clampIndex(selectedTask() + delta, total))
  }
  const jump = (to: "top" | "bottom") => {
    const total = tasks().length
    if (!total) return
    setSelectedTask(to === "top" ? 0 : total - 1)
  }
  const open = () => {
    const task = selected()
    if (task) props.openSession(task.session.sessionID)
  }
  const setCollapse = (collapse: boolean) => {
    if (grouping() !== "hierarchy") return
    const task = selected()
    if (!task || !task.hasChildren) return
    const next = new Set(collapsed())
    if (collapse) next.add(task.session.sessionID)
    else next.delete(task.session.sessionID)
    setCollapsed(next)
    persist({ collapsed: [...next] })
  }
  const cycleFilter = (delta: number) => {
    setFilterIndex((index) => (index + delta + TASK_FILTERS.length) % TASK_FILTERS.length)
    setSelectedTask(0)
  }
  const cycleGrouping = () => {
    const next = nextGrouping(grouping())
    setGrouping(next)
    setSelectedTask(0)
    persist({ grouping: next })
  }
  const openSearch = async (): Promise<void> => {
    const value = await props.ctx.ui.dialog.prompt({
      title: "Search sessions",
      placeholder: "Title, session id, agent, or directory",
      value: search(),
    })
    if (value === undefined) return
    setSearch(value.trim())
    setSelectedTask(0)
  }

  registerDashboardKeys(props.ctx, {
    move,
    page: viewport,
    jump,
    collapse: setCollapse,
    open,
    filter: cycleFilter,
    group: cycleGrouping,
    search: () => void openSearch(),
    help: () => setHelp((value) => !value),
    compose: () => {
      const task = selected()
      if (task) props.compose(task.session.sessionID, task.session.status)
    },
    back: () => {
      if (help()) {
        setHelp(false)
        return
      }
      if (search()) {
        setSearch("")
        setSelectedTask(0)
        return
      }
      props.onClose()
    },
  })

  return (
    <box flexGrow={1} minHeight={0} overflow="hidden" backgroundColor={skin().panel} flexDirection="column">
      <box
        flexDirection="column"
        alignItems="stretch"
        flexGrow={1}
        minHeight={0}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between">
          <text flexShrink={0} fg={skin().text}>
            <b>subplug</b>
            <span style={{ fg: skin().muted }}> command center</span>
            <span style={{ fg: skin().secondary }}>  Group: {groupingLabel(grouping())}  g</span>
          </text>
          <text flexShrink={0} fg={skin().muted}>
            claims {snapshot().registry.claims.filter((claim) => claim.status === "active").length} active
            {snapshot().registry.conflicts.length
              ? ` · ${snapshot().registry.conflicts.length} conflict${snapshot().registry.conflicts.length === 1 ? "" : "s"}`
              : ""}
          </text>
        </box>

        <box flexShrink={0} flexDirection="row" gap={2}>
          {TASK_FILTERS.map((entry, index) => (
            <text
              flexShrink={0}
              fg={index === filterIndex() ? skin().accent : skin().muted}
              onMouseDown={() => {
                setFilterIndex(index)
                setSelectedTask(0)
              }}
            >
              {index === filterIndex()
                ? <b>{`${entry.label} ${counts()[index] ?? 0}`}</b>
                : `${entry.label} ${counts()[index] ?? 0}`}
            </text>
          ))}
        </box>
        <text flexShrink={0} fg={skin().border}>{"─".repeat(Math.max(0, width() - 4))}</text>

        {search() ? (
          <text flexShrink={0} truncate fg={skin().muted}>Search: {search()} · esc clears</text>
        ) : null}

        {help() ? (
          <box flexDirection="column" flexShrink={0} gap={0}>
            <text flexShrink={0} fg={skin().accent}><b>Keyboard shortcuts</b></text>
            <text flexShrink={0} fg={skin().muted}>Navigate</text>
            <text flexShrink={0} fg={skin().text}>  ↑/↓ move · pgup/pgdn page · home/end jump</text>
            <text flexShrink={0} fg={skin().text}>  enter open session · f/m follow-up</text>
            <text flexShrink={0} fg={skin().muted}>View</text>
            <text flexShrink={0} fg={skin().text}>  tab/shift+tab filter · g group · / search · ? help</text>
            <text flexShrink={0} fg={skin().text}>  ←/→ collapse/expand (hierarchy) · esc/q back</text>
          </box>
        ) : (
          <box flexDirection="row" flexGrow={1} minHeight={0} gap={2}>
            <box flexDirection="column" width={listWidth()} flexShrink={1} minWidth={0} overflow="hidden">
              <text flexShrink={0} width={listWidth()} truncate fg={skin().muted}>
                {`${padEnd("", 2)}${padEnd("", 2)}${padEnd("Tasks", titleWidth() + 1)}${showStatus() ? padEnd("Status", 11) : ""}${padStart("Updated", 9)}`}
              </text>
              {rows().length === 0 ? (
                <text flexShrink={0} fg={skin().muted}>{search() ? "no matching sessions" : "no sessions recorded yet"}</text>
              ) : null}
              {start() > 0 ? <text flexShrink={0} fg={skin().muted}>↑</text> : null}
              {(() => {
                const indexMap = taskIndexByDisplay(rows())
                const base = start()
                const selectedRow = displayIndex()
                const current = currentID()
                return visible().map((row, offset) => {
                  const absolute = base + offset
                  if (row.kind === "group") {
                    return (
                      <text flexShrink={0} width={listWidth()} truncate fg={skin().muted}>
                        {squish(`${row.label}  ${row.count}`, listWidth())}
                      </text>
                    )
                  }
                  if (row.kind === "gap") return <text flexShrink={0} width={listWidth()}> </text>
                  const task = row.task
                  const taskIndex = indexMap[absolute] ?? -1
                  const isSelected = absolute === selectedRow
                  const group = task.group
                  const rollup = rollupLabel(rollupSubtree(sessions(), task.session.sessionID))
                  const marker =
                    `${task.depth > 0 ? `${"  ".repeat(task.depth - 1)}└ ` : ""}` +
                    `${task.hasChildren ? (task.collapsed ? "▸ " : "▾ ") : ""}` +
                    `${task.orphan ? "? " : ""}` +
                    `${current === task.session.sessionID ? "• " : ""}` +
                    sessionLabel(task.session) +
                    (rollup ? ` [${rollup}]` : "")
                  return (
                    <text
                      flexShrink={0}
                      width={listWidth()}
                      truncate
                      bg={isSelected ? skin().selection : undefined}
                      onMouseDown={() => {
                        if (taskIndex >= 0) setSelectedTask(taskIndex)
                      }}
                    >
                      <span style={{ fg: isSelected ? skin().accent : skin().muted }}>{isSelected ? "› " : "  "}</span>
                      <span style={{ fg: groupColor(skin(), group) }}>{`${groupMark(group, task.session.status)} `}</span>
                      <span style={{ fg: skin().text }}>{padEnd(squish(marker, titleWidth()), titleWidth() + 1)}</span>
                      {showStatus() ? (
                        <span style={{ fg: groupColor(skin(), group) }}>{padEnd(statusGroupLabel(group), 11)}</span>
                      ) : null}
                      <span style={{ fg: skin().muted }}>
                        {padStart(age(task.session.lastEventAt, snapshot().generatedAt), 9)}
                      </span>
                    </text>
                  )
                })
              })()}
              {start() + viewport() < rows().length ? <text flexShrink={0} fg={skin().muted}>↓</text> : null}
            </box>
            <Show when={wide() && selected()} keyed>
              {(task: TaskRow) => (
                <DetailsPane
                  ctx={props.ctx}
                  state={props.state}
                  session={task.session}
                  group={task.group}
                  current={currentID() === task.session.sessionID}
                />
              )}
            </Show>
          </box>
        )}

        <text flexShrink={0} fg={skin().muted}>
          ↑/↓ move · enter open · tab filter · g group · / search · ? help · f/m follow-up · esc/q back
        </text>
      </box>
    </box>
  )
}
